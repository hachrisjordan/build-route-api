#!/usr/bin/env python3
"""
Google Travel (Explore) capture script.

Captures the network call that starts with:
https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetExploreDestinations
(Only the call after the route is complete: destination is filled first, then origin; earlier
GetExploreDestinations e.g. after continent-only is ignored.)

After the HTTP response is 200, the UI streams results; the script waits for the top progress bar to
finish, then polls Network.getResponseBody until the payload stops growing (several identical reads in
a row) — not the first non-null body.

Usage:
  python scripts/google-flights-calendar-capture.py --origin HAN --destination Europe
  python scripts/google-flights-calendar-capture.py --origin SGN --destination "North America" --headless
  python scripts/google-flights-calendar-capture.py --origin SGN --destination Europe --save-body ./out/explore-body.json
  python scripts/google-flights-calendar-capture.py --origin SGN --print-rows
  python scripts/google-flights-calendar-capture.py --origin HAN,SYD --print-rows
    # Comma-separated origins: one browser session, continent order chosen so handoffs only change "Where from".
    # If "Where from" cannot be set for an airport, stderr prints ``IATA - failed`` and the run continues with the
    # next origin; remaining continents for that airport are marked failed (skipped). After 3 such failures in a row,
    # the script closes the browser and retries the whole capture (same as other capture retries).
    # Omit --destination: looks up each origin's region in Supabase `airports` as that origin's segment starts
    # (and the next airport, for handoff planning), then captures allowed continents.
    # stderr prints explore_run_id=<UUID>; use --resume-run-id <UUID> for stable run identity (logged on each pairing row).
    # Pairing status in Supabase is one row per (origin,continent): reruns update that row; resume skips any pair already success.
    # After each successful "Where from" commit, stderr prints one line: ``AMS - Amsterdam (AMS)`` (from live UI text).

Retries / timeouts:
  Hardcoded in script: timeout=60s, capture_retries=2, retry_delay=5s,
  supabase_retries=3, supabase_retry_delay=1s.

Destination must be an Explore continent name: Africa, Europe, North America, South America, Asia, Oceania.
The script selects the suggestion whose subtext is "Continent" (not a city airport).

After each successful Explore capture, parsed rows are upserted to the configured Supabase Explore output
table (same as below), even when `--print-rows` is not set.

Without `--print-rows`, successful runs do not print capture JSON to stdout (use `--save-body` for raw bodies).

With `--print-rows`, rows are `origin,destination,price,roundtrip,j` and, when both airports have
`latitude`/`longitude` in Supabase `airports`, an extra `cpm` field: cents per mile =
price (USD) / (effective miles) * 100, where effective miles = one-way haversine miles,
or *2 that distance when `roundtrip` is `roundtrip` (out-and-back).
If coordinates are missing, the row is left without `cpm` (unchanged 5 fields).
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Optional, TypeVar
from datetime import datetime, timezone

# Hardcoded timeout/retry configuration (per user request).
CAPTURE_TIMEOUT_SECONDS = 60
CAPTURE_EXTRA_RETRIES = 2
CAPTURE_RETRY_DELAY_SECONDS = 5.0
# Multi-origin auto: skip an airport when "Where from" cannot be set; reopen browser after this many skips in a row.
EXPLORE_CONSECUTIVE_ORIGIN_FAILURES_BEFORE_SESSION_RETRY = 3
SUPABASE_EXTRA_RETRIES = 3
SUPABASE_RETRY_DELAY_SECONDS = 1.0

# Where to store parsed Explore CSV output.
SUPABASE_EXPLORE_OUTPUT_TABLE = "google_flights_explore_destination_prices"
SUPABASE_EXPLORE_PAIRING_STATUS_TABLE = "google_flights_explore_pairing_status"
SUPABASE_EXPLORE_UPSERT_CHUNK_SIZE = 100

ExploreStepMode = Literal["both", "dest_only", "origin_only"]

# Directory containing this file (…/scripts); repo root is one level up.
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent


def patch_distutils():
    """Patch the missing distutils module for Python 3.13+."""
    try:
        import undetected_chromedriver as uc

        return uc
    except ImportError as error:
        if "distutils" not in str(error):
            raise RuntimeError(
                "Missing dependency: undetected_chromedriver. "
                "Install with: pip install undetected-chromedriver"
            ) from error

        import types

        mock_distutils = types.ModuleType("distutils")
        mock_distutils.version = types.ModuleType("distutils.version")

        class LooseVersion:
            def __init__(self, version_string: str):
                self.version_string = str(version_string)
                self.version = str(version_string)
                self.vstring = str(version_string)

            def __str__(self) -> str:
                return self.version_string

            def __repr__(self) -> str:
                return f"LooseVersion('{self.version_string}')"

            def __lt__(self, other: object) -> bool:
                if isinstance(other, LooseVersion):
                    return self.version_string < other.version_string
                return self.version_string < str(other)

            def __eq__(self, other: object) -> bool:
                if isinstance(other, LooseVersion):
                    return self.version_string == other.version_string
                return self.version_string == str(other)

        mock_distutils.version.LooseVersion = LooseVersion
        sys.modules["distutils"] = mock_distutils
        sys.modules["distutils.version"] = mock_distutils.version

        import undetected_chromedriver as uc

        return uc


By = None
Keys = None
EC = None
WebDriverWait = None


class TimeoutException(Exception):
    pass


class WebDriverException(Exception):
    pass


def load_selenium_dependencies() -> None:
    global By, Keys, EC, WebDriverWait, TimeoutException, WebDriverException
    try:
        from selenium.common.exceptions import TimeoutException as SeleniumTimeoutException
        from selenium.common.exceptions import WebDriverException as SeleniumWebDriverException
        from selenium.webdriver.common.by import By as SeleniumBy
        from selenium.webdriver.common.keys import Keys as SeleniumKeys
        from selenium.webdriver.support import expected_conditions as SeleniumEC
        from selenium.webdriver.support.ui import WebDriverWait as SeleniumWebDriverWait
    except ModuleNotFoundError as error:
        raise RuntimeError("Missing dependency: selenium. Install with: pip install selenium") from error

    By = SeleniumBy
    Keys = SeleniumKeys
    EC = SeleniumEC
    WebDriverWait = SeleniumWebDriverWait
    TimeoutException = SeleniumTimeoutException
    WebDriverException = SeleniumWebDriverException


TARGET_PREFIX = (
    "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights."
    "FlightsFrontendService/GetExploreDestinations"
)
IATA_REGEX = re.compile(r"^[A-Z]{3}$")
IS_DARWIN = sys.platform == "darwin"


def _origin_raw_ui_contains_strict_iata(raw_text: Optional[str], iata: str) -> bool:
    """
    True if UI text shows this IATA as an uppercase token or (IATA).

    Important: do not uppercase the whole string and search for ' DEL ' — that false-matches
    Spanish 'del' in e.g. 'Playa del Carmen' after .upper() becomes '... DEL ...'.

    Google Explore often renders typed IATA plus a grey autocompleted suffix with **no** space,
    e.g. value ``AMSterdam Airport Schiphol`` — token boundary checks would miss ``AMS``.

    The concatenation rule must require **literal** uppercase ``AMS`` at the start of the string, not
    ``text[:3].upper() == code`` — otherwise ``Arnhem`` → ``ARNHEM`` false-matches code ``ARN``.

    A non-alphanumeric boundary match on the **uppercased** string accepts ``… AMS``, ``… BER``, ``BAH`` as
    its own token, and ``(BAH)``, but still rejects ``ARNHEM``, ``AMSTERDAM``, and ``BAHRAIN`` as false codes.

    Callers should pass the **visible** editor string (including ``innerText`` for contenteditable), not only
    ``HTMLInputElement.value`` — Explore often leaves ``value`` empty while showing ``AMSterdam…``.
    """
    code = (iata or "").strip().upper()
    if not IATA_REGEX.match(code):
        return False
    text = raw_text or ""
    if f"({code})" in text.upper():
        return True
    # Uppercase IATA typed + lowercase grey continuation (same cell), e.g. "AMSterdam…", "BERlin…".
    if len(text) > len(code) and text[: len(code)] == code:
        suf = text[len(code) : len(code) + 1]
        if suf and suf.islower():
            return True
    # Standalone IATA in uppercase text — "… AIRPORT ARN", "BAH", "(BAH)"; not inside ARNHEM / AMSTERDAM / BAHRAIN.
    u = text.upper()
    iso_boundary = re.compile(rf"(?<![A-Z0-9]){re.escape(code)}(?![A-Z0-9])")
    if iso_boundary.search(u):
        return True
    token_re = re.compile(rf"(^|\s)({re.escape(code)})(?=\s|$)")
    for match in token_re.finditer(text):
        start = match.start(2)
        if text[start : start + 3] == code:
            return True
    return False


def _origin_url_contains_strict_iata(url: str, iata: str) -> bool:
    """Avoid naive `code in url` false positives (e.g. DEL inside unrelated tokens)."""
    code = (iata or "").strip().upper()
    if not IATA_REGEX.match(code):
        return False
    u = (url or "").upper()
    if f"({code})" in u:
        return True
    boundary_re = re.compile(rf"(?<![A-Z0-9]){re.escape(code)}(?![A-Z0-9])")
    return boundary_re.search(u) is not None


def _origin_field_is_collapsed_iata_chip(raw_text: Optional[str], iata: str) -> bool:
    """After commit, Explore sometimes collapses the field to exactly the 3-letter code."""
    code = (iata or "").strip().upper()
    if not IATA_REGEX.match(code):
        return False
    s = (raw_text or "").strip()
    return len(s) == 3 and s.upper() == code


def _origin_route_editor_text_satisfied(
    raw_text: Optional[str],
    iata: str,
    *,
    current_url: str,
) -> bool:
    """Value/innerText counts as origin-set if it matches strict rules or is a 3-letter chip + URL has IATA."""
    if _origin_raw_ui_contains_strict_iata(raw_text, iata):
        return True
    if _origin_field_is_collapsed_iata_chip(raw_text, iata):
        return _origin_url_contains_strict_iata(current_url, iata)
    return False


def _is_explore_origin_not_set_error(exc: BaseException) -> bool:
    """True when `_set_airport` failed to commit the origin (multi-origin skip/retry logic)."""
    return "origin was not set" in str(exc).lower()


def format_explore_origin_set_ack_line(iata: str, raw_display: str) -> str:
    """
    One-line ack for stderr, e.g. ``AMS - Amsterdam (AMS)`` from IATA + committed field text.
    Appends ``(IATA)`` when the UI label does not already include it.
    """
    code = (iata or "").strip().upper()
    d = " ".join((raw_display or "").replace("\n", " ").split()).strip()
    if not d:
        return f"{code} - {code}"
    if d.strip().upper() == code:
        return f"{code} - {code}"
    if f"({code})" in d.upper():
        return f"{code} - {d}"
    return f"{code} - {d} ({code})"


# Explore "Where to" continents: keys are normalized CLI input (lower, collapsed spaces).
EXPLORE_CONTINENT_CANONICAL: Dict[str, str] = {
    "africa": "Africa",
    "europe": "Europe",
    "north america": "North America",
    "south america": "South America",
    "asia": "Asia",
    "oceania": "Oceania",
}

# Regions stored on Supabase `airports.region` (named set used for auto multi-region mode).
AIRPORTS_SUPABASE_REGIONS_ORDERED: List[str] = [
    "Africa",
    "Asia",
    "Europe",
    "North America",
    "Oceania",
    "South America",
]
AIRPORTS_REGION_CANONICAL_SET = set(AIRPORTS_SUPABASE_REGIONS_ORDERED)
# Secondary line on the correct list row in Google's UI (see role="option" + .t7Thuc).
EXPLORE_CONTINENT_SUBTEXT = "Continent"

# Injected ahead of route-field scripts: Google often hides the real editor in shadow DOM or contenteditable.
_GF_EXPLORE_ROUTE_EDITOR_JS = r"""
function gfFindRouteEditor(root) {
  function walk(node) {
    if (!node) return null;
    if (node.nodeType === 11) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const n = node.childNodes[i];
        if (n.nodeType === 1) { const x = walk(n); if (x) return x; }
      }
      return null;
    }
    if (node.nodeType !== 1) return null;
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'INPUT') {
      const t = (node.type || 'text').toLowerCase();
      if (t === 'text' || t === 'search' || t === '') return node;
    }
    if (tag === 'TEXTAREA') return node;
    try {
      if (node.isContentEditable === true && tag !== 'BODY' && tag !== 'HTML') return node;
    } catch (e) {}
    if (node.shadowRoot) {
      const x = walk(node.shadowRoot);
      if (x) return x;
    }
    const ch = node.children;
    for (let i = 0; i < ch.length; i++) {
      const x = walk(ch[i]);
      if (x) return x;
    }
    return null;
  }
  return walk(root);
}
function gfRouteComboMatches(c, want) {
  const al = (c.getAttribute('aria-label') || '').toLowerCase();
  const ed = gfFindRouteEditor(c);
  const ph = ed && ed.getAttribute ? (ed.getAttribute('placeholder') || '').toLowerCase() : '';
  return al.includes(want) || ph.includes(want);
}
"""


@dataclass(frozen=True)
class ExploreStep:
    """One UI+capture step in a multi-origin Explore run."""

    origin_iata: str
    destination_continent: str
    mode: ExploreStepMode


@dataclass
class CaptureResult:
    request: Dict[str, Any]
    response: Dict[str, Any]
    # CDP request id — used to fetch response body after UI settles (getResponseBody is often null at loadingFinished).
    network_request_id: Optional[str] = None

    def to_json(self) -> str:
        return json.dumps({"request": self.request, "response": self.response}, ensure_ascii=True, indent=2)


class GoogleFlightsCalendarCapture:
    def __init__(self, origin: str, destination: str, timeout_seconds: int, headless: bool, debug: bool):
        self.origin = origin
        self.destination = destination
        self.timeout_seconds = timeout_seconds
        self.headless = headless
        self.debug = debug
        self.driver = None
        self._requests: Dict[str, Dict[str, Any]] = {}
        # When False, Network.requestWillBeSent for GetExploreDestinations is ignored (e.g. after destination-only).
        # Set True in run() when starting the origin step; manual mode leaves True for whole session.
        self._record_get_explore_destinations = True
        self._run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self._artifact_dir = os.path.join(os.getcwd(), ".artifacts", "google-flights", self._run_id)

    def _log(self, message: str) -> None:
        if not self.debug:
            return
        print(f"[debug] {message}", file=sys.stderr)

    def _short_error(self, error: Exception) -> str:
        raw = str(error) if error is not None else ""
        first_line = raw.splitlines()[0].strip() if raw else ""
        return f"{type(error).__name__}: {first_line}" if first_line else f"{type(error).__name__}"

    def _ensure_artifact_dir(self) -> None:
        if not self.debug:
            return
        os.makedirs(self._artifact_dir, exist_ok=True)

    def _write_text_artifact(self, filename: str, content: str) -> None:
        if not self.debug:
            return
        self._ensure_artifact_dir()
        path = os.path.join(self._artifact_dir, filename)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            self._log(f"wrote {path}")
        except Exception as e:
            self._log(f"failed writing {path}: {e}")

    def _dump_debug_state(self, reason: str) -> None:
        if not self.debug or self.driver is None:
            return
        self._ensure_artifact_dir()
        try:
            url = getattr(self.driver, "current_url", None)
            title = getattr(self.driver, "title", None)
            self._log(f"dump_state reason={reason!r} url={url!r} title={title!r} artifacts_dir={self._artifact_dir}")
            self._write_text_artifact("state.txt", f"reason={reason}\nurl={url}\ntitle={title}\n")
        except Exception as e:
            self._log(f"state dump failed: {e}")

        try:
            screenshot_path = os.path.join(self._artifact_dir, "screen.png")
            self.driver.save_screenshot(screenshot_path)
            self._log(f"wrote {screenshot_path}")
        except Exception as e:
            self._log(f"screenshot failed: {e}")

        try:
            html = self.driver.page_source or ""
            trimmed = html[:1_500_000]
            self._write_text_artifact("page.html", trimmed)
        except Exception as e:
            self._log(f"page_source dump failed: {e}")

    def setup_driver(self):
        load_selenium_dependencies()
        uc = patch_distutils()
        options = uc.ChromeOptions()

        default_chrome_paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
        ]

        chrome_bin = os.getenv("CHROME_BIN")
        if not chrome_bin:
            for path in default_chrome_paths:
                if os.path.exists(path):
                    chrome_bin = path
                    break
        if chrome_bin and os.path.exists(chrome_bin):
            options.binary_location = chrome_bin

        chromedriver_path = os.getenv("CHROMEDRIVER_PATH")
        if not chromedriver_path:
            try:
                from webdriver_manager.chrome import ChromeDriverManager

                chromedriver_path = ChromeDriverManager().install()
            except Exception:
                default_paths = [
                    "/opt/homebrew/bin/chromedriver",
                    "/usr/local/bin/chromedriver",
                    "/usr/bin/chromedriver",
                ]
                for path in default_paths:
                    if os.path.exists(path):
                        chromedriver_path = path
                        break
                if not chromedriver_path:
                    chromedriver_path = "/usr/bin/chromedriver"

        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument("--disable-software-rasterizer")
        options.add_argument("--disable-extensions")
        options.add_argument("--disable-plugins")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_argument("--disable-web-security")
        options.add_argument("--allow-running-insecure-content")
        options.add_argument("--window-size=1440,1200")
        options.add_argument("--lang=en-US")
        options.set_capability("goog:loggingPrefs", {"performance": "ALL"})

        if self.headless:
            options.add_argument("--headless=new")

        try:
            self.driver = uc.Chrome(
                driver_executable_path=chromedriver_path,
                options=options,
                version_main=None,
                use_subprocess=True,
                headless=self.headless,
            )
        except Exception as error:
            if "Status code was: -9" in str(error) or "unexpectedly exited" in str(error) or "cannot reuse" in str(error):
                fallback_options = uc.ChromeOptions()
                if chrome_bin and os.path.exists(chrome_bin):
                    fallback_options.binary_location = chrome_bin
                fallback_options.add_argument("--no-sandbox")
                fallback_options.add_argument("--disable-dev-shm-usage")
                fallback_options.add_argument("--disable-gpu")
                fallback_options.add_argument("--window-size=1440,1200")
                fallback_options.add_argument("--lang=en-US")
                fallback_options.add_argument("--disable-blink-features=AutomationControlled")
                fallback_options.set_capability("goog:loggingPrefs", {"performance": "ALL"})
                if self.headless:
                    fallback_options.add_argument("--headless=new")

                self.driver = uc.Chrome(
                    options=fallback_options,
                    version_main=None,
                    headless=self.headless,
                )
            else:
                raise

        self.driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        self.driver.execute_cdp_cmd("Network.enable", {})
        self._log("driver ready (Network enabled)")

    def _wait_for_flights_form(self, timeout: int = 20) -> None:
        wait = WebDriverWait(self.driver, timeout)
        wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        # Google Flights is client-rendered; wait for any comboboxes to appear.
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[role='combobox']")))

    def _click_if_present(self, selectors: list[tuple[str, str]], timeout: int = 2, label: str = "") -> bool:
        wait = WebDriverWait(self.driver, timeout)
        for by, selector in selectors:
            try:
                self._log(f"click_try {label} by={by} selector={selector!r} timeout={timeout}s")
                element = wait.until(EC.element_to_be_clickable((by, selector)))
                element.click()
                self._log(f"click_ok {label} selector={selector!r}")
                return True
            except Exception as e:
                self._log(f"click_fail {label} selector={selector!r} error={self._short_error(e)}")
                continue
        return False

    def _accept_cookie_banner_if_present(self):
        # Keep this lightweight; cookie banners often appear in iframes and may be non-clickable.
        self._click_if_present(
            [(By.XPATH, "//button[contains(., 'Accept all') or contains(., 'I agree') or contains(., 'Reject all')]")],
            timeout=1,
            label="cookie_banner",
        )

    def _dismiss_explore_overlays(self) -> None:
        """Close first-run / promo layers that block the sidebar route row."""
        self._click_if_present(
            [
                (By.XPATH, "//button[contains(., 'Get started')]"),
                (By.XPATH, "//button[contains(., 'No thanks')]"),
                (By.XPATH, "//button[contains(., 'Not now')]"),
                (By.XPATH, "//*[@role='button'][contains(., 'Dismiss')]"),
            ],
            timeout=2,
            label="explore_overlay",
        )

    def _click_explore_route_field_js(self, field_type: str) -> bool:
        """
        Explore often renders TWO 'Where from?' comboboxes: a narrow chip + a wide expanded row.
        First match in DOM is usually the chip; typing there stays empty while focus UI shows the wide row.
        Click the narrowest matching combobox first to open, then caller waits and uses widest input.
        """
        try:
            return bool(
                self.driver.execute_script(
                    _GF_EXPLORE_ROUTE_EDITOR_JS
                    + """
        const kind = arguments[0];
        const want = (kind === 'origin') ? 'where from' : 'where to';
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const combos = Array.from(document.querySelectorAll('[role="combobox"]')).filter(isVisible)
          .filter((c) => gfRouteComboMatches(c, want));
        if (!combos.length) return false;
        combos.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
        const targetCombo = combos[0];
        const inp = gfFindRouteEditor(targetCombo) || targetCombo;
        try { inp.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
        const r = inp.getBoundingClientRect();
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: Math.round(r.left + Math.min(12, Math.max(4, r.width / 2))),
          clientY: Math.round(r.top + Math.min(12, Math.max(4, r.height / 2))),
        };
        inp.dispatchEvent(new MouseEvent('mouseover', opts));
        inp.dispatchEvent(new MouseEvent('mousedown', opts));
        inp.dispatchEvent(new MouseEvent('mouseup', opts));
        inp.dispatchEvent(new MouseEvent('click', opts));
        try { inp.focus(); } catch (e) {}
        return true;
        """,
                    field_type,
                )
            )
        except Exception as e:
            self._log(f"click_explore_route_field_js_fail field={field_type} err={self._short_error(e)}")
            return False

    def _focus_explore_route_wide_input_js(self, field_type: str) -> bool:
        """Pointer-activate the widest matching route combobox input (active editor)."""
        try:
            return bool(
                self.driver.execute_script(
                    _GF_EXPLORE_ROUTE_EDITOR_JS
                    + """
        const kind = arguments[0];
        const want = (kind === 'origin') ? 'where from' : 'where to';
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const combos = Array.from(document.querySelectorAll('[role="combobox"]')).filter(isVisible)
          .filter((c) => gfRouteComboMatches(c, want));
        if (!combos.length) return false;
        const expanded = combos.filter((c) => c.getAttribute('aria-expanded') === 'true');
        let pool = expanded.length ? expanded : combos;
        pool = pool.slice().sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
        const chosen = pool[0];
        const inp = gfFindRouteEditor(chosen) || chosen;
        try { inp.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
        const r = inp.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: Math.round(r.left + Math.min(20, r.width / 2)),
          clientY: Math.round(r.top + Math.min(12, r.height / 2)),
        };
        inp.dispatchEvent(new MouseEvent('mouseover', opts));
        inp.dispatchEvent(new MouseEvent('mousedown', opts));
        inp.dispatchEvent(new MouseEvent('mouseup', opts));
        inp.dispatchEvent(new MouseEvent('click', opts));
        try { inp.focus(); } catch (e) {}
        return true;
        """,
                    field_type,
                )
            )
        except Exception as e:
            self._log(f"focus_explore_route_wide_input_js_fail field={field_type} err={self._short_error(e)}")
            return False

    def _find_explore_route_input_js(self, field_type: str):
        """
        Prefer the input inside the widest matching combobox (expanded row), or aria-expanded=true.
        Uses shadow DOM + contenteditable walk (gfFindRouteEditor).
        """
        try:
            return self.driver.execute_script(
                _GF_EXPLORE_ROUTE_EDITOR_JS
                + """
        const kind = arguments[0];
        const want = (kind === 'origin') ? 'where from' : 'where to';
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const combos = Array.from(document.querySelectorAll('[role="combobox"]')).filter(isVisible)
          .filter((c) => gfRouteComboMatches(c, want));
        if (!combos.length) return null;
        const expanded = combos.filter((c) => c.getAttribute('aria-expanded') === 'true');
        let pool = expanded.length ? expanded : combos;
        pool = pool.slice().sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
        for (const c of pool) {
          const ed = gfFindRouteEditor(c);
          if (!ed) continue;
          const r = ed.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return ed;
        }
        return null;
        """,
                field_type,
            )
        except Exception as e:
            self._log(f"find_explore_route_input_js_fail field={field_type} err={self._short_error(e)}")
            return None

    def _route_editor_from_active_element(self):
        """After Google focuses the route row, the real node is often document.activeElement."""
        load_selenium_dependencies()
        try:
            ae = self.driver.switch_to.active_element
            tag = (ae.tag_name or "").lower()
            if tag in ("input", "textarea"):
                return ae
            ce = (ae.get_attribute("contenteditable") or "").strip().lower()
            if ce == "true":
                return ae
        except Exception as e:
            self._log(f"route_editor_active_element_skip {self._short_error(e)}")
        return None

    def _route_editor_display_value(self, element) -> str:
        """Readable text for input/textarea or contenteditable (Selenium .value misses CE)."""
        try:
            return str(
                self.driver.execute_script(
                    """
                    const e = arguments[0];
                    if (!e) return '';
                    if (e.value !== undefined && e.value !== null) return String(e.value);
                    return String((e.innerText || e.textContent || '')).trim();
                    """,
                    element,
                )
            )
        except Exception:
            try:
                return (element.get_attribute("value") or "").strip()
            except Exception:
                return ""

    def _type_via_cdp_dispatch_keys(self, text: str) -> None:
        """Last-resort IME-style key events (some Closure/React builds ignore insertText)."""
        for ch in text:
            if not ch:
                continue
            try:
                self.driver.execute_cdp_cmd(
                    "Input.dispatchKeyEvent",
                    {"type": "keyDown", "text": ch, "key": ch, "unmodifiedText": ch},
                )
                self.driver.execute_cdp_cmd(
                    "Input.dispatchKeyEvent",
                    {"type": "keyUp", "text": ch, "key": ch},
                )
            except Exception as e:
                self._log(f"cdp_dispatchKeyEvent_fail ch={ch!r} err={self._short_error(e)}")
                break

    def _click_nth_combobox(self, index: int, label: str, timeout: int = 10) -> bool:
        """
        Fallback for experiments/locales where aria-labels differ.
        Clicks the nth visible combobox in the main form.
        """
        wait = WebDriverWait(self.driver, timeout)
        try:
            wait.until(EC.presence_of_all_elements_located((By.CSS_SELECTOR, "[role='combobox']")))
            candidates = self.driver.find_elements(By.CSS_SELECTOR, "[role='combobox']")
            visible = [el for el in candidates if el.is_displayed()]
            self._log(f"{label} combobox_visible_count={len(visible)} requested_index={index}")
            if index < 0 or index >= len(visible):
                return False
            visible[index].click()
            self._log(f"click_ok {label} combobox_index={index}")
            return True
        except Exception as e:
            self._log(f"click_fail {label} combobox_index={index} error={type(e).__name__}: {e}")
            return False

    def _debug_dump_visible_comboboxes(self) -> None:
        if not self.debug or self.driver is None:
            return
        try:
            payload = self.driver.execute_script(
                """
                const els = Array.from(document.querySelectorAll('[role="combobox"]'))
                  .filter((el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
                return els.slice(0, 20).map((el, idx) => {
                  const r = el.getBoundingClientRect();
                  const label = el.getAttribute('aria-label');
                  const ph = el.getAttribute('placeholder');
                  const val = (el instanceof HTMLInputElement) ? el.value : null;
                  const txt = (el.textContent || '').trim().slice(0, 80);
                  return { idx, ariaLabel: label, placeholder: ph, value: val, text: txt, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                });
                """
            )
            self._log(f"visible_comboboxes {json.dumps(payload, ensure_ascii=True)}")
            self._write_text_artifact("visible-comboboxes.json", json.dumps(payload, ensure_ascii=True, indent=2))
        except Exception as e:
            self._log(f"visible_comboboxes_dump_failed {type(e).__name__}: {e}")

    def _find_airport_popup_input(self, timeout: int = 10):
        """
        After opening origin/destination, find the active popup text input.
        Prefer dialog-scoped inputs to avoid matching non-search fields.
        """
        wait = WebDriverWait(self.driver, timeout)
        # If focus is already on a text input, prefer that.
        try:
            focused = self.driver.execute_script("return document.activeElement && document.activeElement.tagName;")
            if str(focused).lower() == "input":
                el = self.driver.switch_to.active_element
                if el and el.is_displayed():
                    return el
        except Exception:
            pass

        xpaths = [
            # Common: search field inside a dialog
            "//div[@role='dialog']//input[@type='text']",
            # Sometimes it's a listbox/popover region
            "//*[@role='listbox']//input[@type='text']",
            # Your devtools example: "Where else?"
            "//input[@type='text' and contains(@aria-label, 'Where else')]",
            # Often has aria-autocomplete
            "//input[@type='text' and @role='combobox']",
            # Generic fallback
            "//input[@type='text']",
        ]
        last_error: Optional[Exception] = None
        for xp in xpaths:
            try:
                self._log(f"search_input_wait xpath={xp!r}")
                el = wait.until(EC.presence_of_element_located((By.XPATH, xp)))
                if el and el.is_displayed():
                    return el
            except Exception as e:
                last_error = e
                self._log(f"search_input_not_found xpath={xp!r} error={type(e).__name__}: {e}")
        if last_error:
            raise last_error
        raise TimeoutException("Could not locate airport search input.")

    def _wait_for_route_set(
        self,
        field_type: str,
        expected_token: str,
        before_value: str,
        before_url: str,
        timeout: int = 12,
    ) -> bool:
        """
        Verifies the route is set without relying on fragile combobox indices.
        Origin: strict IATA (or URL / combobox contains it).
        Destination: Explore continent label (normalized spaces) or committed field change.
        """
        expected = " ".join(expected_token.strip().upper().split())
        deadline = time.time() + timeout

        if field_type == "origin":
            field_xpath = (
                "//input[contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')]"
                " | //input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')]"
            )
        else:
            field_xpath = (
                "//input[contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where to')]"
                " | //input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where to')]"
            )

        while time.time() < deadline:
            try:
                # 1) Directly read the visible field input value/aria-label (prefer widest row — Explore duplicate "Where from").
                els = self.driver.find_elements(By.XPATH, field_xpath)
                visible_els = [el for el in els if el.is_displayed()]
                try:
                    visible_els.sort(key=lambda e: int(e.size.get("width", 0)), reverse=True)
                except Exception:
                    pass
                for el in visible_els:
                    val_raw = el.get_attribute("value") or ""
                    # Explore often uses a contenteditable route editor: `.value` is empty while
                    # `AMSsterdam…` / `Amsterdam…` only appears in innerText (see _route_editor_display_value).
                    display_raw = ""
                    try:
                        display_raw = self._route_editor_display_value(el)
                    except Exception:
                        display_raw = ""
                    aria_raw = el.get_attribute("aria-label") or ""
                    aria = aria_raw.upper()
                    val = val_raw.upper()
                    if field_type == "origin":
                        try:
                            cur_url = self.driver.current_url or ""
                        except Exception:
                            cur_url = ""
                        if val_raw.strip() and _origin_route_editor_text_satisfied(
                            val_raw, expected, current_url=cur_url
                        ):
                            self._log(f"route_set_ok field={field_type} reason=input value_attr val={val_raw!r}")
                            return True
                        if display_raw.strip() and _origin_route_editor_text_satisfied(
                            display_raw, expected, current_url=cur_url
                        ):
                            self._log(
                                f"route_set_ok field={field_type} reason=input display_text val={display_raw!r} "
                                f"value_attr={val_raw!r}"
                            )
                            return True
                        if _origin_raw_ui_contains_strict_iata(aria_raw, expected):
                            self._log(f"route_set_ok field={field_type} reason=input aria val={aria_raw!r}")
                            return True
                    elif expected in val or expected in aria:
                        self._log(f"route_set_ok field={field_type} reason=input val={val!r}")
                        return True
                    if field_type == "destination":
                        # Continent flow: require chosen continent label in the field (not arbitrary city names).
                        if val and expected in val:
                            self._log(f"route_set_ok field=destination reason=destination_val_contains_continent val={val!r}")
                            return True
                    # Origin: do NOT accept arbitrary non-empty val (was causing false positives).
            except Exception:
                pass

            try:
                # 2) URL must contain the IATA code (do not accept any vague tfs= change without it).
                url = (self.driver.current_url or "").upper()
                if field_type == "origin":
                    if _origin_url_contains_strict_iata(url, expected):
                        self._log(f"route_set_ok field={field_type} reason=url_contains_iata")
                        return True
                elif expected in url:
                    self._log(f"route_set_ok field={field_type} reason=url_contains_iata")
                    return True
            except Exception:
                pass

            try:
                # 3) Combobox visible text, excluding open suggestion list (avoids "SGN" from dropdown only).
                visible_blob = self.driver.execute_script(
                    _GF_EXPLORE_ROUTE_EDITOR_JS
                    + """
                    const isOrigin = arguments[0] === 'origin';
                    const want = isOrigin ? 'where from' : 'where to';
                    const isVisible = (el) => {
                      if (!el) return false;
                      const r = el.getBoundingClientRect();
                      return r.width > 0 && r.height > 0;
                    };
                    const combos = Array.from(document.querySelectorAll('[role="combobox"]')).filter(isVisible)
                      .filter((c) => gfRouteComboMatches(c, want));
                    if (!combos.length) return null;
                    const expanded = combos.filter((c) => c.getAttribute('aria-expanded') === 'true');
                    let pool = expanded.length ? expanded : combos;
                    pool = pool.slice().sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
                    let input = null;
                    for (const c of pool) {
                      const ed = gfFindRouteEditor(c);
                      if (!ed) continue;
                      const r = ed.getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) { input = ed; break; }
                    }
                    if (!input) return null;
                    let root = input.closest('[role="combobox"]');
                    if (!root) root = input.parentElement;
                    if (!root) return null;
                    const rawVal = (input.value !== undefined && input.value !== null)
                      ? input.value
                      : (input.innerText || input.textContent || '');
                    const iv = String(rawVal || '').toUpperCase();
                    const ivRaw = String(rawVal || '');
                    const iaRaw = input.getAttribute('aria-label') || '';
                    const ia = String(iaRaw || '').toUpperCase();
                    let shellRaw = ((root.innerText || root.textContent || '') + '');
                    const lb = root.querySelector('[role="listbox"]');
                    if (lb) {
                      const ltRaw = (lb.innerText || lb.textContent || '') + '';
                      shellRaw = shellRaw.split(ltRaw).join(' ');
                    }
                    shellRaw = shellRaw.replace(/\\s+/g, ' ').trim();
                    const shell = shellRaw.toUpperCase();
                    return { iv, ivRaw, ia, iaRaw, shell, shellRaw };
                    """,
                    field_type,
                )
                if visible_blob and isinstance(visible_blob, dict):
                    iv = str(visible_blob.get("iv") or "")
                    ia = str(visible_blob.get("ia") or "")
                    shell = str(visible_blob.get("shell") or "")
                    iv_raw = str(visible_blob.get("ivRaw") or "")
                    ia_raw = str(visible_blob.get("iaRaw") or "")
                    shell_raw = str(visible_blob.get("shellRaw") or "")
                    if field_type == "origin":
                        try:
                            cur_url_blob = self.driver.current_url or ""
                        except Exception:
                            cur_url_blob = ""
                        if (
                            _origin_route_editor_text_satisfied(iv_raw, expected, current_url=cur_url_blob)
                            or _origin_raw_ui_contains_strict_iata(ia_raw, expected)
                            or _origin_raw_ui_contains_strict_iata(shell_raw, expected)
                        ):
                            self._log(
                                f"route_set_ok field=origin reason=combobox_text "
                                f"iv={iv!r} ivRaw={iv_raw!r}"
                            )
                            return True
                    else:
                        if expected in iv or expected in ia or expected in shell:
                            self._log(f"route_set_ok field=destination reason=combobox_text")
                            return True
            except Exception:
                pass

            time.sleep(0.25)

        self._log(f"route_set_fail field={field_type} expected={expected!r} (timeout)")
        return False

    def _read_committed_origin_display_value(self) -> str:
        """Widest visible Explore 'Where from' editor text after a successful origin set."""
        field_xpath = (
            "//input[contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')]"
            " | //input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')]"
        )
        try:
            els = self.driver.find_elements(By.XPATH, field_xpath)
            visible_els = [el for el in els if el.is_displayed()]
            try:
                visible_els.sort(key=lambda e: int(e.size.get("width", 0)), reverse=True)
            except Exception:
                pass
            for el in visible_els:
                v = self._route_editor_display_value(el).strip()
                if v:
                    return v
        except Exception:
            pass
        return ""

    def _select_explore_continent_option(self, continent_display: str, subtext: str, timeout: int = 10) -> bool:
        """
        Picks li[role=option] where primary label matches the continent and .t7Thuc subtext matches (e.g. Continent).
        Aligns with Google Flights DOM: zsRT0d / jsname=V1ur5d for title, t7Thuc for secondary line.
        """
        deadline = time.time() + timeout
        js_pick = r"""
        const continent = String(arguments[0] || '').trim();
        const subWant = String(arguments[1] || '').trim();
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const wantC = norm(continent);
        const wantS = norm(subWant);
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const options = Array.from(document.querySelectorAll('li[role="option"], [role="option"]')).filter(isVisible);
        for (const li of options) {
          const aria = norm(li.getAttribute('aria-label') || '');
          let primary = '';
          const p1 = li.querySelector('.zsRT0d') || li.querySelector('[jsname="V1ur5d"]');
          if (p1) primary = norm((p1.innerText || p1.textContent || ''));
          let subLine = '';
          const st = li.querySelector('.t7Thuc');
          if (st) subLine = norm((st.innerText || st.textContent || ''));
          const primaryOk = primary === wantC || aria === wantC;
          const subOk = subLine === wantS;
          if (!primaryOk || !subOk) continue;
          try { li.scrollIntoView({ block: 'center' }); } catch (e) {}
          const rect = li.getBoundingClientRect();
          const opts = { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 };
          li.dispatchEvent(new MouseEvent('mouseover', opts));
          li.dispatchEvent(new MouseEvent('mousedown', opts));
          li.dispatchEvent(new MouseEvent('mouseup', opts));
          li.dispatchEvent(new MouseEvent('click', opts));
          return true;
        }
        return false;
        """

        while time.time() < deadline:
            try:
                picked = bool(
                    self.driver.execute_script(js_pick, continent_display, subtext)
                )
                if picked:
                    return True
            except Exception:
                pass
            time.sleep(0.25)
        return False

    def _select_suggestion_by_exact_iata(self, iata_code: str, timeout: int = 8) -> bool:
        """
        Select only a suggestion that actually shows this IATA (e.g. '(DEL)' or uppercase ' DEL ').

        Never selects the first suggestion blindly.

        Note: uppercasing the entire suggestion and searching for ' DEL ' false-matches Spanish
        'del' in e.g. 'Playa del Carmen' → '... DEL ...'.
        """
        target = iata_code.upper()
        deadline = time.time() + timeout

        js_pick = r"""
        const target = String(arguments[0] || '').toUpperCase();
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const scoreStrict = (txt) => {
          const raw = String(txt || '');
          const upper = raw.toUpperCase();
          let s = 0;
          if (upper.includes('(' + target + ')')) s = Math.max(s, 4);
          try {
            const isoB = new RegExp('(?<![A-Z0-9])' + target + '(?![A-Z0-9])');
            if (isoB.test(upper)) s = Math.max(s, 3);
          } catch (e) {}
          if (raw.length > target.length && raw.substring(0, target.length) === target) {
            const next = raw[target.length];
            if (next && next >= 'a' && next <= 'z') s = Math.max(s, 2);
          }
          const re = new RegExp('(^|\\s)' + target + '(?=\\s|$)', 'g');
          let m;
          while ((m = re.exec(raw)) !== null) {
            const idx = m.index + m[1].length;
            if (raw.substring(idx, idx + target.length) === target) {
              s = Math.max(s, 1);
              break;
            }
          }
          return s;
        };
        const buildPool = (nodeList) => {
          return Array.from(nodeList)
            .filter(isVisible)
            .map((el) => {
              const txt = (el.innerText || el.textContent || '').trim();
              const s = scoreStrict(txt);
              const li = el.tagName === 'LI' || el.getAttribute('role') === 'option';
              const ap = /\\bairport\\b/i.test(txt);
              return { el, txt, s, li, ap };
            })
            .filter((x) => x.s > 0)
            .sort((a, b) => {
              if (b.s !== a.s) return b.s - a.s;
              if (b.li !== a.li) return (b.li ? 1 : 0) - (a.li ? 1 : 0);
              return (b.ap ? 1 : 0) - (a.ap ? 1 : 0);
            });
        };
        let pool = buildPool(document.querySelectorAll('li[role="option"], [role="option"]'));
        if (!pool.length) {
          pool = buildPool(document.querySelectorAll('li,[role="option"],div,span'));
        }
        const preferred = pool[0];
        if (!preferred) return false;
        try { preferred.el.scrollIntoView({block:'center'}); } catch(e) {}
        preferred.el.click();
        return true;
        """

        while time.time() < deadline:
            try:
                picked = bool(self.driver.execute_script(js_pick, target))
                if picked:
                    return True
            except Exception:
                pass
            time.sleep(0.25)
        return False

    def _type_into_input_robust(self, element, text: str) -> None:
        """
        Reliable typing for Google Explore inputs:
        Selenium send_keys, ActionChains, CDP insertText + dispatchKeyEvent, then native setter / contenteditable.
        """
        try:
            self.driver.execute_script("window.focus();")
        except Exception:
            pass

        # Step 1: Real pointer-style activation (Explore often needs this before suggestions appear).
        try:
            self.driver.execute_script(
                """
                const el = arguments[0];
                if (!el) return;
                try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch(e) {}
                const r = el.getBoundingClientRect();
                const opts = {
                  bubbles: true,
                  cancelable: true,
                  clientX: Math.round(r.left + Math.min(10, r.width / 2)),
                  clientY: Math.round(r.top + Math.min(10, r.height / 2)),
                };
                el.dispatchEvent(new MouseEvent('mouseover', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
                try { el.focus(); } catch(e) {}
                """,
                element,
            )
        except Exception:
            pass

        # Step 2: Try standard keys.
        try:
            element.click()
        except Exception:
            pass
        try:
            self.driver.execute_script("arguments[0].focus();", element)
        except Exception:
            pass
        try:
            element.send_keys(Keys.COMMAND if IS_DARWIN else Keys.CONTROL, "a")
        except Exception:
            try:
                element.send_keys(Keys.CONTROL, "a")
            except Exception:
                pass
        try:
            element.send_keys(Keys.BACKSPACE)
            element.send_keys(text)
        except Exception:
            pass

        # Step 2b: ActionChains (different focus path than element.send_keys).
        try:
            cur_ac = self._route_editor_display_value(element).strip().upper()
            if cur_ac != text.strip().upper():
                from selenium.webdriver.common.action_chains import ActionChains

                ActionChains(self.driver).move_to_element(element).click().pause(0.12).send_keys(text).perform()
        except Exception as e:
            self._log(f"actionchains_type_fail {self._short_error(e)}")

        # Step 3: CDP only if keys did not commit (avoids doubling text when send_keys already worked).
        try:
            cur = self._route_editor_display_value(element).strip().upper()
            if cur != text.strip().upper():
                try:
                    self.driver.execute_script("arguments[0].focus(); arguments[0].click();", element)
                except Exception:
                    pass
                self.driver.execute_cdp_cmd("Input.insertText", {"text": text})
        except Exception as e:
            self._log(f"cdp_Input.insertText_failed {self._short_error(e)}")

        # Step 3b: per-character CDP keys
        try:
            cur_k = self._route_editor_display_value(element).strip().upper()
            if cur_k != text.strip().upper():
                try:
                    self.driver.execute_script("arguments[0].focus();", element)
                except Exception:
                    pass
                self._type_via_cdp_dispatch_keys(text)
        except Exception as e:
            self._log(f"cdp_dispatch_keys_block_fail {self._short_error(e)}")

        # Step 4: Hard fallback: native value setter + InputEvent (React listens to inputType).
        try:
            cur2 = self._route_editor_display_value(element).strip().upper()
            if cur2 == text.strip().upper():
                return
            self.driver.execute_script(
                """
                const el = arguments[0];
                const val = arguments[1];
                if (!el) return;
                try { el.focus(); } catch (e) {}
                if (el.isContentEditable) {
                  el.textContent = val;
                  try {
                    el.dispatchEvent(new InputEvent('input', {
                      bubbles: true,
                      cancelable: true,
                      inputType: 'insertText',
                      data: val,
                    }));
                  } catch (e2) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                  return;
                }
                const proto = Object.getPrototypeOf(el);
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && desc.set) {
                  desc.set.call(el, '');
                  desc.set.call(el, val);
                } else {
                  el.value = val;
                }
                try {
                  el.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: val,
                  }));
                } catch (e) {
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
                el.dispatchEvent(new Event('change', { bubbles: true }));
                """,
                element,
                text,
            )
        except Exception:
            pass

    def _set_airport(
        self,
        field_type: str,
        route_value: str,
        *,
        enable_explore_capture_after_destination: bool = False,
        explore_capture_origin_only_handoff: bool = False,
    ):
        """route_value: origin = IATA; destination = canonical continent label (e.g. North America)."""
        self._log(f"set_airport start field={field_type} value={route_value!r}")
        if field_type == "destination" and enable_explore_capture_after_destination:
            # Same idea as initial load: ignore GetExploreDestinations until the new continent is set.
            self._purge_tracked_get_explore_destinations()
            self._record_get_explore_destinations = False
            self._log("destination-only change: explore capture paused until continent confirmed")

        if field_type == "origin":
            if explore_capture_origin_only_handoff:
                self._purge_tracked_get_explore_destinations()
                self._record_get_explore_destinations = False
                self._log("origin-only handoff: explore capture paused until new origin confirmed")
            else:
                # Destination is set first; Explore may send GetExploreDestinations then. Record only from origin onward.
                self._purge_tracked_get_explore_destinations()
                self._record_get_explore_destinations = True
                self._log("explore_capture enabled for origin (ignores GetExploreDestinations after destination-only)")
            trigger_selectors = [
                (By.XPATH, "//*[@role='combobox'][contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')]"),
                (By.XPATH, "//input[contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')]"),
                (By.XPATH, "//input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')]"),
                (By.XPATH, "//*[@aria-label='Enter your origin']"),
                (By.XPATH, "//button[contains(@aria-label, 'Where from')]"),
                (By.XPATH, "//input[contains(@aria-label, 'Where from')]"),
                (By.XPATH, "//*[contains(text(), 'Where from')]"),
                (By.XPATH, "//*[@aria-label and contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'origin')]"),
            ]
            field_input_xpath = (
                "//input[contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')] | "
                "//input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where from')]"
            )
        else:
            trigger_selectors = [
                (By.XPATH, "//*[@role='combobox'][contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where to')]"),
                (By.XPATH, "//input[contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where to')]"),
                (By.XPATH, "//input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where to')]"),
                (By.XPATH, "//*[@aria-label='Enter your destination']"),
                (By.XPATH, "//button[contains(@aria-label, 'Where to')]"),
                (By.XPATH, "//input[contains(@aria-label, 'Where to')]"),
                (By.XPATH, "//*[contains(text(), 'Where to')]"),
                (By.XPATH, "//*[@aria-label and contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'destination')]"),
            ]
            field_input_xpath = (
                "//input[contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where to')] | "
                "//input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'where to')]"
            )

        # Prefer JS: Explore puts aria-label on the combobox; inner input may lack it (XPath misses).
        opened = self._click_explore_route_field_js(field_type)
        if not opened:
            opened = self._click_if_present(trigger_selectors, timeout=8, label=f"{field_type}_open")
        if not opened:
            opened = self._click_explore_route_field_js(field_type)

        if not opened:
            self._dump_debug_state(f"open_{field_type}_selector_failed")
            raise TimeoutException(f"Could not open {field_type} selector.")

        # Two "Where from?" nodes: narrow chip + wide editor. Open chip, then target the wide row for keys.
        time.sleep(0.5)
        self._focus_explore_route_wide_input_js(field_type)
        time.sleep(0.28)

        # Prefer document.activeElement (Google often moves focus to shadow/contenteditable not found by XPath).
        search_input = self._route_editor_from_active_element()
        if search_input is not None:
            self._log(f"{field_type}_prefer_document_active_element tag={search_input.tag_name!r}")

        before_url = (self.driver.current_url or "").upper()
        if search_input is None:
            try:
                search_input = self._find_explore_route_input_js(field_type)
            except Exception:
                search_input = None

        if search_input is None:
            try:
                field_inputs = self.driver.find_elements(By.XPATH, field_input_xpath)
                visible_els = [el for el in field_inputs if el.is_displayed()]
                try:
                    visible_els.sort(key=lambda e: int(e.size.get("width", 0)), reverse=True)
                except Exception:
                    pass
                for el in visible_els:
                    search_input = el
                    break
            except Exception:
                search_input = None

        if search_input is None:
            try:
                search_input = self._find_airport_popup_input(timeout=10)
            except Exception as e:
                self._log(f"search_input_missing field={field_type} error={type(e).__name__}: {e}")
                self._dump_debug_state(f"search_input_missing_{field_type}")
                raise

        try:
            before_value = self._route_editor_display_value(search_input).upper() if search_input is not None else ""
        except Exception:
            before_value = ""

        try:
            search_input.click()
        except Exception:
            pass
        try:
            # Force focus to the exact input on Explore sidebar.
            self.driver.execute_script("arguments[0].focus();", search_input)
        except Exception:
            pass
        self._type_into_input_robust(search_input, route_value)
        time.sleep(0.2)
        try:
            current_val = " ".join(self._route_editor_display_value(search_input).strip().upper().split())
            want_val = (
                " ".join(route_value.strip().upper().split())
                if field_type == "destination"
                else route_value.strip().upper()
            )
            if current_val != want_val:
                self._log(f"{field_type}_type_retry value_before_retry={current_val!r}")
                self._type_into_input_robust(search_input, route_value)
        except Exception:
            pass
        # Give suggestions time to render (Explore can be slow; origin list + IATA matching needs it).
        time.sleep(1.05 if field_type == "origin" else 0.8)

        if field_type == "destination":
            picked = self._select_explore_continent_option(
                route_value, EXPLORE_CONTINENT_SUBTEXT, timeout=10
            )
            self._log(f"{field_type}_pick_continent_subtext={picked}")
            if not picked:
                self._log(f"{field_type}_no_continent_option: will press Enter")
                try:
                    search_input.send_keys(Keys.ENTER)
                except Exception:
                    pass
        else:
            # Keyboard-first: first dropdown row is usually the airport (AMS → Schiphol). Matches real UX.
            self._log(f"{field_type}_commit_keyboard_down_enter_primary")
            try:
                search_input.send_keys(Keys.ARROW_DOWN)
                time.sleep(0.22)
                search_input.send_keys(Keys.ENTER)
            except Exception:
                pass
            time.sleep(0.42)
            picked_exact_iata = self._select_suggestion_by_exact_iata(route_value, timeout=5)
            self._log(f"{field_type}_pick_exact_iata_after_keyboard={picked_exact_iata}")
            if not picked_exact_iata:
                self._log(
                    f"{field_type}_no_exact_iata_pick: try ArrowDown+Enter again then plain Enter; "
                    "origin must show IATA in field/URL/combobox (not loose heuristics)."
                )
                try:
                    search_input.send_keys(Keys.ARROW_DOWN)
                    time.sleep(0.2)
                    search_input.send_keys(Keys.ENTER)
                except Exception:
                    try:
                        search_input.send_keys(Keys.ENTER)
                    except Exception:
                        pass

        # Wait briefly for dropdown to close / URL to update.
        time.sleep(0.55 if field_type == "origin" else 0.4)

        # Do NOT send Escape for origin: on Explore it often clears the committed airport and leaves
        # only the typed IATA (e.g. "AMS" + ghost), causing false "origin was not set" timeouts.
        try:
            has_open_list = bool(
                self.driver.execute_script(
                    """
                    const lb = document.querySelector('[role="listbox"]');
                    if (lb) {
                      const r = lb.getBoundingClientRect();
                      if (r.width > 1 && r.height > 1) return true;
                    }
                    return Array.from(document.querySelectorAll('[role="combobox"]')).some(
                      (c) => c.getAttribute('aria-expanded') === 'true'
                    );
                    """
                )
            )
            if has_open_list and field_type != "origin":
                search_input.send_keys(Keys.ESCAPE)
        except Exception:
            pass

        if not self._wait_for_route_set(
            field_type=field_type,
            expected_token=route_value,
            before_value=before_value,
            before_url=before_url,
            timeout=18 if field_type == "origin" else 12,
        ):
            safe = re.sub(r"[^\w\-]+", "_", route_value.strip())[:40]
            self._dump_debug_state(f"{field_type}_value_not_set_{safe}")
            raise TimeoutException(f"{field_type} was not set to {route_value!r}.")

        if field_type == "origin":
            time.sleep(0.15)
            display = self._read_committed_origin_display_value()
            print(
                format_explore_origin_set_ack_line(route_value, display),
                file=sys.stderr,
            )

        # Multi-region: after changing continent only, enable capture without re-picking origin.
        if field_type == "destination" and enable_explore_capture_after_destination:
            self._purge_tracked_get_explore_destinations()
            self._record_get_explore_destinations = True
            self._log(
                "explore_capture enabled after destination set (origin unchanged; "
                "awaiting GetExploreDestinations for new continent)"
            )

        if field_type == "origin" and explore_capture_origin_only_handoff:
            self._purge_tracked_get_explore_destinations()
            self._record_get_explore_destinations = True
            self._log("explore_capture enabled after origin-only handoff (destination unchanged)")

        self._log(f"set_airport done field={field_type} value={route_value!r}")

    def _set_business_class(self):
        self._log("set_business_class start")
        self._debug_dump_visible_comboboxes()

        def get_cabin_label() -> Optional[str]:
            try:
                label = self.driver.execute_script(
                    r"""
                    const isVisible = (el) => {
                      if (!el) return false;
                      const r = el.getBoundingClientRect();
                      return r.width > 0 && r.height > 0;
                    };
                    const texts = ['Economy','Business','First','Premium economy','Premium Economy'];
                    const nodes = Array.from(document.querySelectorAll('button,[role="combobox"],div,span'))
                      .filter(isVisible)
                      .map((el) => ({ el, t: ((el.innerText||el.textContent||'')+'').trim() }))
                      .filter((x) => texts.some((w) => x.t === w || x.t.startsWith(w)));
                    if (!nodes.length) return null;
                    nodes.sort((a,b) => a.el.getBoundingClientRect().y - b.el.getBoundingClientRect().y);
                    return nodes[0].t || null;
                    """
                )
                return str(label) if label else None
            except Exception:
                return None

        # If Business is already selected, skip.
        try:
            if self.driver.find_elements(By.XPATH, "//*[contains(normalize-space(.), 'Business') and (@role='combobox' or self::button)]"):
                self._log("set_business_class skip (Business already present in UI)")
                return
        except Exception:
            pass

        before = get_cabin_label()
        self._log(f"cabin_label_before={before!r}")

        # Explore sidebar shows plain-text "Economy" dropdown (stable in your runs).
        # Keep this path minimal and deterministic.
        try:
            opened_by_text = bool(
                self.driver.execute_script(
                    r"""
                    const isVisible = (el) => {
                      if (!el) return false;
                      const r = el.getBoundingClientRect();
                      return r.width > 0 && r.height > 0;
                    };
                    const hay = (el) => ((el.innerText || el.textContent || '')).trim();
                    const candidates = Array.from(document.querySelectorAll('button,[role="combobox"],div,span'))
                      .filter(isVisible)
                      .filter((el) => {
                        const t = hay(el);
                        return t === 'Economy' || t.startsWith('Economy') || t.includes('Economy');
                      });
                    const target = candidates.find((el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'combobox') || candidates[0];
                    if (!target) return false;
                    target.click();
                    return true;
                    """
                )
            )
            if opened_by_text:
                self._log("cabin_open_by_text ok")
        except Exception as e:
            self._log(f"cabin_open_by_text_failed {type(e).__name__}: {e}")
            opened_by_text = False

        if not opened_by_text:
            # Known fallback from your `visible-comboboxes.json`: index 1 is cabin class.
            opened_by_text = self._click_nth_combobox(1, label="cabin_open_fallback_1", timeout=4)

        if not opened_by_text:
            self._dump_debug_state("open_cabin_selector_failed")
            raise TimeoutException("Could not open cabin class selector.")

        # Select Business via JS click to avoid ElementClickIntercepted overlays.
        selected = False
        try:
            selected = bool(
                self.driver.execute_script(
                    r"""
                    const isVisible = (el) => {
                      if (!el) return false;
                      const r = el.getBoundingClientRect();
                      return r.width > 0 && r.height > 0;
                    };
                    const candidates = Array.from(document.querySelectorAll('[role="option"], li, button, div, span'))
                      .filter(isVisible)
                      .filter((el) => ((el.innerText||el.textContent||'')+'').includes('Business'));
                    const el = candidates.find((x) => x.getAttribute && x.getAttribute('role') === 'option') || candidates[0];
                    if (!el) return false;
                    try { el.scrollIntoView({block:'center'}); } catch(e) {}
                    // Dispatch a real-ish click sequence
                    const rect = el.getBoundingClientRect();
                    const opts = { bubbles:true, cancelable:true, clientX: rect.left+5, clientY: rect.top+5 };
                    el.dispatchEvent(new MouseEvent('mouseover', opts));
                    el.dispatchEvent(new MouseEvent('mousedown', opts));
                    el.dispatchEvent(new MouseEvent('mouseup', opts));
                    el.dispatchEvent(new MouseEvent('click', opts));
                    return true;
                    """
                )
            )
            self._log(f"cabin_choose_business_js selected={selected}")
        except Exception as e:
            self._log(f"cabin_choose_business_js_failed {type(e).__name__}: {e}")
            selected = False

        if not selected:
            self._dump_debug_state("choose_business_failed")
            raise TimeoutException("Could not select Business class.")

        time.sleep(0.4)
        after = get_cabin_label()
        self._log(f"cabin_label_after={after!r}")
        if after and "Business" not in after:
            # Retry once: reopen and try again.
            self._log("cabin_verify_failed retrying_once")
            try:
                # Index 2 on Explore is "Where from", not cabin — use Economy combobox (index 1) or JS.
                self._click_nth_combobox(1, label="cabin_open_retry", timeout=4)
                time.sleep(0.2)
                self.driver.execute_script(
                    "document.querySelectorAll('[role=\"option\"],li').forEach(el=>{if((el.innerText||'').includes('Business')) el.click();});"
                )
                time.sleep(0.4)
            except Exception:
                pass
            after2 = get_cabin_label()
            self._log(f"cabin_label_after_retry={after2!r}")
            if after2 and "Business" not in after2:
                self._dump_debug_state("cabin_still_not_business")
                raise TimeoutException("Cabin label did not switch to Business.")

        self._log("set_business_class done")

    def _open_departure_date_picker(self):
        self._log("open_departure_date_picker start")
        clicked = self._click_if_present(
            [
                (By.XPATH, "//button[contains(@aria-label, 'Departure')]"),
                (By.XPATH, "//input[contains(@aria-label, 'Departure')]"),
                (By.XPATH, "//*[@role='combobox' and contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'departure')]"),
                (By.XPATH, "//*[contains(text(), 'Departure')]"),
                (By.XPATH, "//button[contains(., 'Departure')]"),
            ],
            timeout=8,
            label="departure_date_open",
        )
        if not clicked:
            # Fallback: date combobox is often after origin+destination; try a later combobox index.
            if self._click_nth_combobox(2, label="departure_date_open_fallback", timeout=8):
                self._log("open_departure_date_picker done (fallback combobox index 2)")
                return
            self._dump_debug_state("open_departure_date_failed")
            raise TimeoutException("Could not click departure date control.")
        self._log("open_departure_date_picker done")

    def _explore_loader_ui_state_js(self) -> str:
        """
        Explore top linear loader state (Material progressbar).
        absent — no matching visible bar (not mounted yet, or removed).
        loading — bar visible, inner track not at rest (scaleX not 0).
        done — bar visible, all inner tracks read as finished.

        Do not treat absent as "finished" until loading was seen — avoids exiting before the bar mounts.
        """
        try:
            return str(
                self.driver.execute_script(
                    r"""
                    const isVisible = (el) => {
                      if (!el) return false;
                      const r = el.getBoundingClientRect();
                      return r.width > 1 && r.height > 1;
                    };
                    const innerBar = (bar) => bar.querySelector('[jsname="xFtQrc"]')
                      || bar.querySelector('div[class*="qNpTzb-P4pF8c"]');
                    const scaleDone = (el) => {
                      if (!el) return false;
                      const inline = (el.getAttribute('style') || '');
                      if (/scaleX\s*\(\s*0(?:\.0+)?\s*\)/i.test(inline)) return true;
                      try {
                        const t = window.getComputedStyle(el).transform;
                        if (!t || t === 'none') return false;
                        const m = t.match(/matrix\(([^)]+)\)/);
                        if (m) {
                          const a = parseFloat(m[1].split(',')[0].trim());
                          if (!Number.isNaN(a) && Math.abs(a) < 0.02) return true;
                        }
                      } catch (e) {}
                      return false;
                    };
                    let bars = Array.from(document.querySelectorAll('[role="progressbar"][jsname="LbNpof"]'))
                      .filter(isVisible);
                    if (!bars.length) {
                      bars = Array.from(document.querySelectorAll('[role="progressbar"]')).filter(isVisible)
                        .filter((b) => {
                          const r = b.getBoundingClientRect();
                          if (r.top > 320) return false;
                          return !!innerBar(b);
                        });
                    }
                    if (!bars.length) return 'absent';
                    for (const bar of bars) {
                      const inner = innerBar(bar);
                      if (!inner) return 'loading';
                      if (!scaleDone(inner)) return 'loading';
                    }
                    return 'done';
                    """
                )
            )
        except Exception as e:
            self._log(f"explore_loader_state_failed {self._short_error(e)}")
            return "loading"

    def _wait_until_explore_results_bar_idle(self, timeout: Optional[float] = None) -> None:
        """
        GetExploreDestinations can return 200 while the map/list still fills.
        Wait until the top loader has appeared (loading) and then finished (stable scaleX0 or bar removed).
        """
        limit = timeout if timeout is not None else max(45.0, float(self.timeout_seconds) + 30.0)
        deadline = time.time() + limit
        self._log(f"explore_wait_top_loader_idle timeout={limit}s (see loader then scaleX0)")
        time.sleep(0.55)
        saw_loading = False
        saw_done_once = False
        while time.time() < deadline:
            state = self._explore_loader_ui_state_js()
            if state == "loading":
                saw_loading = True
                time.sleep(0.3)
                continue
            if state == "done":
                saw_done_once = True
                time.sleep(0.45)
                if self._explore_loader_ui_state_js() == "done":
                    self._log("explore_top_loader_idle ok (scaleX0 stable)")
                    return
                saw_loading = True
                continue
            if saw_loading and saw_done_once:
                self._log("explore_top_loader_idle ok (bar gone after done)")
                return
            if saw_loading:
                time.sleep(0.35)
                if self._explore_loader_ui_state_js() == "absent":
                    self._log("explore_top_loader_idle ok (bar removed post-load)")
                    return
                continue
            time.sleep(0.25)
        self._log("explore_top_loader_idle timed_out (returning capture anyway)")

    def _get_response_body_via_cdp(self, request_id: str) -> Optional[str]:
        """Single attempt; returns None on CDP failure (body not ready or request evicted)."""
        try:
            body_response = self.driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": request_id})
            raw_body = body_response.get("body", "")
            if body_response.get("base64Encoded"):
                return base64.b64decode(raw_body).decode("utf-8", errors="replace")
            return raw_body if isinstance(raw_body, str) else str(raw_body)
        except WebDriverException as e:
            self._log(f"getResponseBody WebDriver {self._short_error(e)}")
            return None
        except Exception as e:
            self._log(f"getResponseBody {self._short_error(e)}")
            return None

    def _finalize_capture_with_body(self, result: CaptureResult) -> CaptureResult:
        """
        GetExploreDestinations streams: CDP may return a body early that keeps growing until the UI loader
        stops. We wait for the loader first (caller), then poll getResponseBody until the same payload
        repeats for several consecutive reads (buffer stopped changing).
        """
        rid = result.network_request_id
        if not rid or self.driver is None:
            return result
        if result.response.get("body") is not None:
            return result
        limit = max(60.0, float(self.timeout_seconds) + 35.0)
        deadline = time.time() + limit
        stable_reads_needed = 3
        poll_interval = 0.5
        self._log(
            f"Network.getResponseBody until stable x{stable_reads_needed} "
            f"(streamed body) timeout={limit}s id={rid[:16]}…"
        )
        last_snapshot: Optional[str] = None
        streak = 0
        attempt = 0
        while time.time() < deadline:
            attempt += 1
            body = self._get_response_body_via_cdp(rid)
            if body is None:
                time.sleep(poll_interval)
                continue
            if last_snapshot is not None and body == last_snapshot:
                streak += 1
                if streak >= stable_reads_needed:
                    result.response["body"] = body
                    self._log(
                        f"getResponseBody stable (x{stable_reads_needed}) attempts={attempt} chars={len(body)}"
                    )
                    return result
            else:
                last_snapshot = body
                streak = 1
            time.sleep(poll_interval)
        if last_snapshot is not None:
            result.response["body"] = last_snapshot
            self._log(
                f"getResponseBody timeout — using last snapshot chars={len(last_snapshot)} "
                f"(wanted {stable_reads_needed} stable reads, got streak {streak})"
            )
        else:
            self._log("getResponseBody exhausted — response.body remains null")
        return result

    def _purge_tracked_get_explore_destinations(self) -> None:
        """Remove in-flight/completed GetExploreDestinations from the map (e.g. before listening post-destination)."""
        self._requests = {
            rid: data
            for rid, data in self._requests.items()
            if not str(data.get("request", {}).get("url", "")).startswith(TARGET_PREFIX)
        }

    def _process_performance_logs(self) -> Optional[CaptureResult]:
        entries = self.driver.get_log("performance")
        for entry in entries:
            try:
                message = json.loads(entry["message"])["message"]
                method = message.get("method")
                params = message.get("params", {})
            except Exception:
                continue

            if method == "Network.requestWillBeSent":
                request_id = params.get("requestId")
                request = params.get("request", {})
                url = request.get("url", "")
                if request_id and url.startswith(TARGET_PREFIX):
                    if not self._record_get_explore_destinations:
                        continue
                    self._requests[request_id] = {
                        "request": {
                            "url": url,
                            "method": request.get("method"),
                            "headers": request.get("headers", {}),
                            "postData": request.get("postData"),
                            "timestamp": params.get("timestamp"),
                        },
                        "response": {},
                    }

            elif method == "Network.responseReceived":
                request_id = params.get("requestId")
                if request_id not in self._requests:
                    continue
                response = params.get("response", {})
                self._requests[request_id]["response"] = {
                    "url": response.get("url"),
                    "status": response.get("status"),
                    "statusText": response.get("statusText"),
                    "mimeType": response.get("mimeType"),
                    "headers": response.get("headers", {}),
                    "body": None,
                }

            elif method == "Network.loadingFinished":
                request_id = params.get("requestId")
                if request_id not in self._requests:
                    continue

                captured = self._requests[request_id]
                response_payload = captured.get("response", {})
                if "status" not in response_payload:
                    continue

                # Do not call getResponseBody here — it is frequently null until the stream/UI settles.
                response_payload["body"] = None
                return CaptureResult(
                    request=captured["request"],
                    response=response_payload,
                    network_request_id=request_id,
                )
        return None

    def bootstrap_explore_session(self) -> None:
        """Open Explore once: driver, navigate, dismiss chrome, business class (no route fields)."""
        load_selenium_dependencies()
        self.setup_driver()
        # Ignore GetExploreDestinations until destination is set (Explore fires once after origin, again after destination).
        self._record_get_explore_destinations = False
        self._purge_tracked_get_explore_destinations()
        self._log("navigate to Google Travel Explore")
        self.driver.get("https://www.google.com/travel/explore")
        self._wait_for_flights_form(timeout=25)
        time.sleep(1.2)
        self._accept_cookie_banner_if_present()
        time.sleep(0.6)
        self._dismiss_explore_overlays()
        time.sleep(0.4)
        self._dump_debug_state("after_initial_load")

        # Explore uses a similar "Where from/to" route picker, but may vary by experiment.
        self._set_business_class()

    def capture_for_destination(
        self, destination_continent: str, *, reselect_origin: bool = True
    ) -> CaptureResult:
        """
        Set Where to (continent), then Where from (origin) unless reselect_origin is False.
        When origin is unchanged, only the destination field is updated; capture is armed after
        the new continent is confirmed.
        Call after bootstrap_explore_session(). Reuses the same browser tab.
        """
        self.destination = destination_continent
        self._log(
            f"capture_for_destination continent={destination_continent!r} "
            f"reselect_origin={reselect_origin}"
        )
        if reselect_origin:
            self._set_airport("destination", destination_continent)
            self._set_airport("origin", self.origin)
        else:
            self._set_airport(
                "destination",
                destination_continent,
                enable_explore_capture_after_destination=True,
            )

        return self._await_get_explore_destinations_capture(destination_continent)

    def _await_get_explore_destinations_capture(self, destination_continent: str) -> CaptureResult:
        deadline = time.time() + self.timeout_seconds
        partial_match: Optional[CaptureResult] = None
        while time.time() < deadline:
            result = self._process_performance_logs()
            if result is not None:
                self._wait_until_explore_results_bar_idle()
                return self._finalize_capture_with_body(result)

            for rid, item in self._requests.items():
                request_url = str(item.get("request", {}).get("url", ""))
                if request_url.startswith(TARGET_PREFIX) and item.get("response"):
                    partial_match = CaptureResult(
                        request=item["request"],
                        response=item["response"],
                        network_request_id=rid,
                    )
            if partial_match is not None:
                self._wait_until_explore_results_bar_idle()
                return self._finalize_capture_with_body(partial_match)

            time.sleep(0.5)

        raise TimeoutException(
            f"Did not capture a matching request within {self.timeout_seconds}s "
            f"(destination={destination_continent!r}). "
            "Try --manual to perform actions yourself and verify selectors for your locale."
        )

    def capture_planned_step(self, step: ExploreStep) -> CaptureResult:
        """
        Execute one planned step: both fields, destination-only, or origin-only (multi-origin handoff).
        """
        self._log(
            f"capture_planned_step mode={step.mode!r} origin={step.origin_iata!r} "
            f"dest={step.destination_continent!r}"
        )
        self.destination = step.destination_continent
        self.origin = step.origin_iata

        if step.mode == "both":
            self._set_airport("destination", step.destination_continent)
            self._set_airport("origin", step.origin_iata)
        elif step.mode == "dest_only":
            self._set_airport(
                "destination",
                step.destination_continent,
                enable_explore_capture_after_destination=True,
            )
        elif step.mode == "origin_only":
            self._set_airport(
                "origin",
                step.origin_iata,
                explore_capture_origin_only_handoff=True,
            )
        else:
            raise ValueError(f"Unknown Explore step mode: {step.mode!r}")

        return self._await_get_explore_destinations_capture(step.destination_continent)

    def run(self) -> CaptureResult:
        self.bootstrap_explore_session()
        return self.capture_for_destination(self.destination)

    def run_multi_destinations(self, destinations: List[str]) -> List[CaptureResult]:
        """
        One browser session: bootstrap once, then capture each continent in order.
        Origin is only set on the first continent; later iterations change Where to only.
        """
        self.bootstrap_explore_session()
        results: List[CaptureResult] = []
        for index, dest in enumerate(destinations):
            results.append(
                self.capture_for_destination(dest, reselect_origin=(index == 0))
            )
        return results

    def run_planned_steps(self, steps: List[ExploreStep]) -> List[CaptureResult]:
        """One browser session over explicit steps (multi-origin safe handoffs)."""
        self.bootstrap_explore_session()
        results: List[CaptureResult] = []
        for step in steps:
            results.append(self.capture_planned_step(step))
        return results

    def close(self):
        if self.driver is not None:
            try:
                self.driver.quit()
            except Exception:
                pass

    def install_dom_mutation_logger(self) -> None:
        """
        Installs a MutationObserver that records lightweight DOM change events into window.__domMutations.
        Useful for manual replication: you click/type, we see what changed.
        """
        if self.driver is None:
            return
        script = r"""
        (function() {
          if (window.__domMutationLoggerInstalled) return;
          window.__domMutationLoggerInstalled = true;
          window.__domMutations = window.__domMutations || [];
          const push = (evt) => {
            try {
              window.__domMutations.push(Object.assign({ ts: Date.now() }, evt));
              if (window.__domMutations.length > 2000) window.__domMutations.splice(0, 1000);
            } catch (e) {}
          };
          const describe = (node) => {
            try {
              if (!node || !node.tagName) return null;
              const tag = node.tagName.toLowerCase();
              const id = node.id ? ('#' + node.id) : '';
              const cls = node.className && typeof node.className === 'string'
                ? ('.' + node.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.'))
                : '';
              const aria = node.getAttribute && node.getAttribute('aria-label');
              return { tag, id, cls, aria };
            } catch (e) { return null; }
          };
          const obs = new MutationObserver((muts) => {
            for (const m of muts) {
              if (m.type === 'attributes') {
                push({ type: 'attr', attr: m.attributeName, target: describe(m.target) });
              } else if (m.type === 'childList') {
                push({
                  type: 'childList',
                  added: Array.from(m.addedNodes || []).slice(0, 5).map(describe),
                  removed: Array.from(m.removedNodes || []).slice(0, 5).map(describe),
                  target: describe(m.target),
                });
              }
            }
          });
          obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
          push({ type: 'init', href: location.href, title: document.title });
        })();
        """
        self.driver.execute_script(script)

    def drain_dom_mutations(self) -> list[dict]:
        if self.driver is None:
            return []
        try:
            return self.driver.execute_script(
                "const a = window.__domMutations || []; window.__domMutations = []; return a;"
            )
        except Exception:
            return []

    def run_manual(self) -> CaptureResult:
        """
        Opens Explore, installs mutation logger, and then waits for the target network call.
        You perform actions manually in the opened browser.
        """
        load_selenium_dependencies()
        self.setup_driver()
        self.driver.get("https://www.google.com/travel/explore")
        self._wait_for_flights_form(timeout=25)
        time.sleep(1)
        self._accept_cookie_banner_if_present()
        self._dismiss_explore_overlays()
        time.sleep(1)
        self.install_dom_mutation_logger()
        self._dump_debug_state("manual_ready")
        self._log("manual_mode ready: perform actions in the browser now")

        deadline = time.time() + self.timeout_seconds
        while time.time() < deadline:
            for evt in self.drain_dom_mutations():
                self._log(f"dom_mutation {json.dumps(evt, ensure_ascii=True)}")

            result = self._process_performance_logs()
            if result is not None:
                self._wait_until_explore_results_bar_idle()
                return self._finalize_capture_with_body(result)
            time.sleep(0.4)

        raise TimeoutException(f"Manual mode timed out after {self.timeout_seconds}s without capturing target request.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture Google Travel Explore GetExploreDestinations request and response.")
    parser.add_argument(
        "--origin",
        required=True,
        type=str,
        help="Origin IATA code(s), comma-separated for multiple (e.g. HAN or HAN,SYD).",
    )
    parser.add_argument(
        "--resume-run-id",
        type=str,
        default=None,
        help=(
            "Run UUID (from explore_run_id stderr); stored on each pairing row when it changes. "
            "Resume skips (origin,continent) pairs already marked success in the DB (one row per pair, updated each run)."
        ),
    )
    parser.add_argument(
        "--destination",
        required=False,
        default=None,
        type=str,
        help=(
            'Explore continent: Africa | Europe | "North America" | "South America" | Asia | Oceania. '
            "If omitted, uses Supabase `airports.region` for --origin and captures all other regions in one session."
        ),
    )
    parser.add_argument("--headless", action="store_true", help="Run browser in headless mode")
    parser.add_argument("--debug", action="store_true", help="Verbose debug logs + save screenshot/html artifacts")
    parser.add_argument("--manual", action="store_true", help="Open browser for manual actions + log DOM mutations")
    parser.add_argument(
        "--save-body",
        metavar="PATH",
        type=str,
        default=None,
        help="Write only the response body to this file (UTF-8). Parent dirs are created. Example: ./out/body.json",
    )
    parser.add_argument(
        "--print-rows",
        action="store_true",
        help=(
            "Parse the captured GetExploreDestinations body and print CSV rows to stdout. "
            "Without this flag, capture JSON is not printed (use --save-body for raw bodies). "
            "Adds optional 6th field cpm (cent per mile = price / effective_miles * 100; "
            "effective_miles = haversine mi, or 2x haversine when roundtrip=roundtrip) when origin and destination exist in Supabase "
            "airports with latitude/longitude."
        ),
    )
    parser.add_argument(
        "--rows-limit",
        type=int,
        default=-1,
        help="Max parsed rows to print sorted by price asc. Use -1 to print all.",
    )
    parser.add_argument(
        "--rows-only",
        type=str,
        default=None,
        help="Comma-separated destination IATA codes to include (e.g. LHR,CDG). Default: no filtering.",
    )
    return parser.parse_args()


def normalize_iata(raw: str, field_name: str) -> str:
    value = raw.strip().upper()
    if not IATA_REGEX.match(value):
        raise ValueError(f"{field_name} must be a 3-letter IATA code, got: {raw!r}")
    return value


T = TypeVar("T")


def _should_retry_supabase_transient(exc: BaseException) -> bool:
    """Do not retry validation/data errors or missing optional dependencies."""
    if isinstance(exc, ValueError):
        return False
    if isinstance(exc, RuntimeError) and "Missing dependency" in str(exc):
        return False
    return True


def run_with_retries(
    label: str,
    max_attempts: int,
    delay_seconds: float,
    debug: bool,
    fn: Callable[[], T],
    *,
    should_retry: Optional[Callable[[BaseException], bool]] = None,
) -> T:
    """
    Run fn() up to max_attempts times. On failure, sleep delay_seconds before the next attempt.
    Re-raises the last exception if all attempts fail or should_retry returns False.
    """
    if max_attempts < 1:
        max_attempts = 1
    retry_ok = should_retry or (lambda _e: True)
    last_exc: Optional[BaseException] = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except KeyboardInterrupt:
            raise
        except BaseException as exc:
            last_exc = exc
            if attempt >= max_attempts or not retry_ok(exc):
                raise
            print(
                f"[retry] {label}: attempt {attempt}/{max_attempts} ({type(exc).__name__}: {exc}); "
                f"sleeping {delay_seconds}s",
                file=sys.stderr,
            )
            if debug:
                import traceback

                traceback.print_exc(limit=5, file=sys.stderr)
            time.sleep(max(0.0, float(delay_seconds)))
    assert last_exc is not None
    raise last_exc


def save_response_body_to_path(path: str, body: Optional[str]) -> None:
    """
    Write the raw response body to disk (UTF-8). Creates parent directories.
    Use a .json extension for GetExploreDestinations payloads.
    """
    abs_path = os.path.abspath(path)
    parent = os.path.dirname(abs_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(body if body is not None else "")


def normalize_explore_continent(raw: str) -> str:
    key = " ".join(raw.strip().lower().split())
    if key not in EXPLORE_CONTINENT_CANONICAL:
        allowed = ", ".join(sorted(set(EXPLORE_CONTINENT_CANONICAL.values())))
        raise ValueError(
            f"destination must be an Explore continent ({allowed}), got: {raw!r}"
        )
    return EXPLORE_CONTINENT_CANONICAL[key]


def _parse_dotenv_file(path: Path) -> Dict[str, str]:
    """
    Minimal .env reader when python-dotenv is not installed.
    Fills only missing keys via setdefault in load_env_into_os_environ.
    """
    result: Dict[str, str] = {}
    if not path.is_file():
        return result
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return result
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        if key:
            result[key] = val
    return result


def load_env_into_os_environ() -> None:
    """
    Load variables from .env into os.environ without overriding existing exports.

    Search order:
    1. ./.env (current working directory — where you ran the command)
    2. <repo>/.env (parent of scripts/, same layout as this repo)

    Uses python-dotenv when available; always applies a minimal parser as fallback so
    venvs without `python-dotenv` still pick up Next.js-style NEXT_PUBLIC_* keys.
    """
    candidates: List[Path] = []
    for base in (Path.cwd(), _REPO_ROOT):
        try:
            candidates.append((base / ".env").resolve())
        except OSError:
            candidates.append(base / ".env")

    seen: set[Path] = set()
    unique_paths: List[Path] = []
    for p in candidates:
        if p not in seen:
            seen.add(p)
            unique_paths.append(p)

    try:
        from dotenv import load_dotenv

        for env_path in unique_paths:
            if env_path.is_file():
                load_dotenv(env_path, override=False)
    except ImportError:
        pass

    for env_path in unique_paths:
        for key, val in _parse_dotenv_file(env_path).items():
            if key:
                os.environ.setdefault(key, val)


def get_supabase_credentials() -> tuple[str, str]:
    """
    Read Supabase URL/key from the environment (same names as Next.js / local .env).
    Prefer anon key for read-only `airports` access; allow service role as fallback.
    """
    load_env_into_os_environ()
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = (
        os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    )
    if not url or not key:
        raise ValueError(
            "Missing Supabase configuration. Set NEXT_PUBLIC_SUPABASE_URL and "
            "NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_URL / SUPABASE_ANON_KEY / "
            "SUPABASE_SERVICE_ROLE_KEY) in the process environment, or add them to "
            f"a .env file at {Path.cwd() / '.env'} or {_REPO_ROOT / '.env'}."
        )
    return url, key


def get_supabase_write_credentials() -> tuple[str, str]:
    """
    Read Supabase URL/service-role key for write operations.

    Uses NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY.
    """
    load_env_into_os_environ()
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not service_role_key:
        raise ValueError(
            "Missing Supabase write configuration. Set NEXT_PUBLIC_SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY in your environment (.env at cwd or repo root)."
        )
    return url, service_role_key


def fetch_successful_pairing_keys(
    run_id: uuid.UUID,
    *,
    debug: bool = False,
) -> set[tuple[str, str]]:
    """`(origin_iata, destination_region)` pairs already marked success (global, not scoped by ``run_id``).

    The table keeps one row per pair; ``run_id`` is only written when that row is updated.
    """
    try:
        from supabase import create_client
    except ImportError:
        if debug:
            print("pairing resume: missing supabase library", file=sys.stderr)
        return set()
    try:
        url, key = get_supabase_write_credentials()
    except ValueError as error:
        if debug:
            print(f"pairing resume: {error}", file=sys.stderr)
        return set()
    client = create_client(url, key)
    try:
        response = (
            client.table(SUPABASE_EXPLORE_PAIRING_STATUS_TABLE)
            .select("origin_iata,destination_region")
            .eq("status", "success")
            .execute()
        )
    except Exception as error:
        if debug:
            print(f"pairing resume fetch failed: {error}", file=sys.stderr)
        return set()
    if debug:
        print(
            f"pairing resume: {len(getattr(response, 'data', None) or [])} success row(s) globally "
            f"(run_id context {run_id})",
            file=sys.stderr,
        )
    out: set[tuple[str, str]] = set()
    for row in getattr(response, "data", None) or []:
        o = (row.get("origin_iata") or "").strip().upper()
        d = (row.get("destination_region") or "").strip()
        if o and d:
            out.add((o, d))
    return out


def upsert_explore_pairing_status(
    run_id: uuid.UUID,
    origin_iata: str,
    destination_region: str,
    status: str,
    *,
    error_message: Optional[str] = None,
    debug: bool = False,
) -> None:
    if status not in ("success", "failed"):
        raise ValueError(f"Invalid pairing status: {status!r}")
    try:
        from supabase import create_client
    except ImportError:
        if debug:
            print("pairing status: skip (no supabase)", file=sys.stderr)
        return
    try:
        url, key = get_supabase_write_credentials()
    except ValueError as error:
        if debug:
            print(f"pairing status: skip ({error})", file=sys.stderr)
        return
    row: Dict[str, Any] = {
        "run_id": str(run_id),
        "origin_iata": origin_iata.strip().upper(),
        "destination_region": destination_region,
        "status": status,
    }
    if error_message is not None:
        row["error_message"] = (error_message[:8000] if error_message else None)
    client = create_client(url, key)
    # One DB row per (origin_iata, destination_region); refresh run_id/status on each capture.
    res = (
        client.table(SUPABASE_EXPLORE_PAIRING_STATUS_TABLE)
        .upsert(row, on_conflict="origin_iata,destination_region")
        .execute()
    )
    status_code = 200
    if isinstance(res, dict):
        status_code = int(res.get("status_code", 200) or 200)
    if status_code >= 400:
        raise RuntimeError(f"Pairing status write failed (status_code={status_code}): {res}")


def fetch_airport_region_from_supabase(iata: str) -> str:
    """
    Return canonical region label from `airports.region` for the given IATA code.
    Raises if the row is missing, region is empty, Unknown, or not in the named set.
    """
    try:
        from supabase import create_client
    except ImportError as error:
        raise RuntimeError(
            "Missing dependency: supabase. Install with: pip install supabase"
        ) from error

    url, key = get_supabase_credentials()
    client = create_client(url, key)
    code = iata.strip().upper()
    response = (
        client.table("airports")
        .select("region")
        .eq("iata", code)
        .limit(1)
        .execute()
    )
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ValueError(f"Origin airport {code!r} not found in Supabase airports table.")

    raw_region = (rows[0].get("region") or "").strip()
    if not raw_region or raw_region.lower() == "unknown":
        raise ValueError(
            f"Origin airport {code!r} has missing or Unknown region in airports table; "
            "cannot infer multi-region targets."
        )

    for canonical in AIRPORTS_SUPABASE_REGIONS_ORDERED:
        if canonical.lower() == raw_region.lower():
            return canonical

    raise ValueError(
        f"Origin airport {code!r} has unrecognized region {raw_region!r}. "
        f"Expected one of: {', '.join(AIRPORTS_SUPABASE_REGIONS_ORDERED)}."
    )


def remaining_explore_regions(origin_region: str) -> List[str]:
    """All named Supabase/Explore regions except the origin's region (stable order)."""
    if origin_region not in AIRPORTS_REGION_CANONICAL_SET:
        raise ValueError(f"Invalid origin region for multi-run: {origin_region!r}")
    return [r for r in AIRPORTS_SUPABASE_REGIONS_ORDERED if r != origin_region]


def allowed_explore_regions_for_home(home_region: str, base_order: List[str]) -> List[str]:
    """Continents allowed as Explore destinations for an airport in `home_region` (canonical labels)."""
    if home_region not in AIRPORTS_REGION_CANONICAL_SET:
        raise ValueError(f"Invalid home region: {home_region!r}")
    return [r for r in base_order if r != home_region]


def _first_region_in_base_order(candidates: set[str], base_order: List[str]) -> str:
    """Deterministic pick: first continent in `base_order` that appears in `candidates`."""
    for r in base_order:
        if r in candidates:
            return r
    raise ValueError("No candidate region found in base_order (empty intersection?).")


def _pick_handoff_from_intersection(
    inter: set[str],
    *,
    avoid_prev: Optional[str],
    base_order: List[str],
) -> str:
    """Choose handoff continent from a non-empty intersection (same tie-break as multi-origin planner)."""
    if not inter:
        raise ValueError("internal: empty intersection passed to _pick_handoff_from_intersection")
    if avoid_prev is not None and len(inter) > 1 and avoid_prev in inter:
        inter_minus = inter - {avoid_prev}
        if inter_minus:
            return _first_region_in_base_order(inter_minus, base_order)
    return _first_region_in_base_order(inter, base_order)


def _region_order_first_origin(allowed: List[str], r_end: str) -> List[str]:
    """Rotate allowed list so `r_end` is last (first origin in multi-origin run)."""
    idx = allowed.index(r_end)
    return allowed[idx + 1 :] + allowed[: idx + 1]


def _region_order_middle_origin(
    allowed: List[str],
    r_start: str,
    r_end: str,
    base_order: List[str],
) -> List[str]:
    """Interior origin: start at r_start, end at r_end (handoff chain)."""
    if r_start == r_end:
        if len(allowed) == 1:
            return allowed[:]
        idx = allowed.index(r_start)
        return allowed[idx:] + allowed[:idx]
    middle = [x for x in allowed if x not in (r_start, r_end)]
    middle.sort(key=lambda x: base_order.index(x))
    return [r_start] + middle + [r_end]


def _region_order_last_origin(allowed: List[str], r_start: str, base_order: List[str]) -> List[str]:
    """Final origin: begin at r_start, then remaining continents in base order."""
    tail = [x for x in allowed if x != r_start]
    tail.sort(key=lambda x: base_order.index(x))
    return [r_start] + tail


class MultiOriginExploreHandoffPlanner:
    """
    Yields one origin's Explore continent plan at a time. Only looks up the current origin and the next
    (via `fetch_home`, typically cached) when advancing — so the browser can start after the first pair
    is resolved instead of waiting for every origin's region lookup.
    """

    def __init__(
        self,
        origins: List[str],
        fetch_home: Callable[[str], str],
        base_order: Optional[List[str]] = None,
    ) -> None:
        self.base = base_order if base_order is not None else AIRPORTS_SUPABASE_REGIONS_ORDERED
        self.codes = [o.strip().upper() for o in origins if o.strip()]
        for c in self.codes:
            if not IATA_REGEX.match(c):
                raise ValueError(f"Invalid IATA in origins list: {c!r}")
        self.n = len(self.codes)
        self.fetch_home = fetch_home
        self.handoffs: List[str] = []
        self._next_index = 0

    def next_segment(self) -> tuple[int, str, List[str]]:
        """Return (origin_index, origin_iata, region_plan). Raises StopIteration when finished."""
        if self._next_index >= self.n:
            raise StopIteration

        i = self._next_index
        code = self.codes[i]
        home_i = self.fetch_home(code)
        S_i = allowed_explore_regions_for_home(home_i, self.base)

        if self.n == 1:
            plan = S_i
        elif i == 0:
            home_next = self.fetch_home(self.codes[i + 1])
            S_next = allowed_explore_regions_for_home(home_next, self.base)
            inter = set(S_i) & set(S_next)
            if not inter:
                raise ValueError(
                    f"No common Explore continent between {code!r} (home {home_i!r}) and "
                    f"{self.codes[i + 1]!r} (home {home_next!r}); cannot build handoff order."
                )
            h = _pick_handoff_from_intersection(inter, avoid_prev=None, base_order=self.base)
            self.handoffs.append(h)
            plan = _region_order_first_origin(S_i, h)
        elif i < self.n - 1:
            home_next = self.fetch_home(self.codes[i + 1])
            S_next = allowed_explore_regions_for_home(home_next, self.base)
            inter = set(S_i) & set(S_next)
            if not inter:
                raise ValueError(
                    f"No common Explore continent between {code!r} (home {home_i!r}) and "
                    f"{self.codes[i + 1]!r} (home {home_next!r}); cannot build handoff order."
                )
            h = _pick_handoff_from_intersection(inter, avoid_prev=self.handoffs[-1], base_order=self.base)
            self.handoffs.append(h)
            plan = _region_order_middle_origin(S_i, self.handoffs[-2], self.handoffs[-1], self.base)
        else:
            plan = _region_order_last_origin(S_i, self.handoffs[-1], self.base)

        self._next_index = i + 1
        return i, code, plan


def plan_multi_origin_region_orders_incremental(
    origins: List[str],
    fetch_home: Callable[[str], str],
    base_order: Optional[List[str]] = None,
) -> List[List[str]]:
    """
    Same continent sequences as `plan_multi_origin_region_orders`, but resolves each origin using only
    the current and next airport per segment when driven by `MultiOriginExploreHandoffPlanner`.
    """
    planner = MultiOriginExploreHandoffPlanner(origins, fetch_home, base_order)
    out: List[List[str]] = []
    while True:
        try:
            _idx, _code, plan = planner.next_segment()
        except StopIteration:
            break
        out.append(plan)
    return out


def build_explore_steps_for_origin_index(
    origin_iata: str,
    origin_index: int,
    regions: List[str],
) -> List[ExploreStep]:
    """Build ExploreStep list for one origin (modes match `build_explore_steps_from_region_plans`)."""
    o = origin_iata.strip().upper()
    steps: List[ExploreStep] = []
    for r_idx, continent in enumerate(regions):
        if origin_index == 0 and r_idx == 0:
            mode: ExploreStepMode = "both"
        elif r_idx == 0:
            mode = "origin_only"
        else:
            mode = "dest_only"
        steps.append(ExploreStep(origin_iata=o, destination_continent=continent, mode=mode))
    return steps


def plan_multi_origin_region_orders(
    origins: List[str],
    home_by_iata: Dict[str, str],
    base_order: Optional[List[str]] = None,
) -> List[List[str]]:
    """
    Build per-origin continent sequences for multi-origin capture with single-field UI handoffs.

    For consecutive origins O_i, O_{i+1}, the last continent for O_i equals the first for O_{i+1},
    and that continent lies in (allowed_i ∩ allowed_{i+1}) so after O_i capture only "Where from"
    must change (destination unchanged).

    `home_by_iata` maps uppercased IATA -> canonical region (from Supabase `airports.region`).
    """
    codes = [o.strip().upper() for o in origins if o.strip()]

    def fetch_home(code: str) -> str:
        h = home_by_iata.get(code.strip().upper())
        if not h:
            raise ValueError(f"Missing home region for origin {code.strip().upper()!r} in home_by_iata")
        return h

    return plan_multi_origin_region_orders_incremental(origins, fetch_home, base_order)


def build_explore_steps_from_region_plans(
    origins: List[str],
    region_plans: List[List[str]],
) -> List[ExploreStep]:
    """Turn per-origin continent lists into ordered ExploreStep sequence (handoff-safe modes)."""
    if len(origins) != len(region_plans):
        raise ValueError("origins and region_plans must have the same length")
    steps: List[ExploreStep] = []
    for o_idx, origin in enumerate(origins):
        o = origin.strip().upper()
        regions = region_plans[o_idx]
        for r_idx, continent in enumerate(regions):
            if o_idx == 0 and r_idx == 0:
                mode: ExploreStepMode = "both"
            elif r_idx == 0:
                mode = "origin_only"
            else:
                mode = "dest_only"
            steps.append(ExploreStep(origin_iata=o, destination_continent=continent, mode=mode))
    return steps


def build_explore_steps_explicit_destination(
    origins: List[str],
    continent: str,
) -> List[ExploreStep]:
    """Same explicit Explore continent for each origin; only origin changes after the first (origin_only)."""
    canon = normalize_explore_continent(continent)
    steps: List[ExploreStep] = []
    for i, origin in enumerate(origins):
        o = origin.strip().upper()
        mode: ExploreStepMode = "both" if i == 0 else "origin_only"
        steps.append(ExploreStep(origin_iata=o, destination_continent=canon, mode=mode))
    return steps


def parse_origins_csv(raw: str) -> List[str]:
    """Comma-separated IATA codes (e.g. ``HAN,SYD``)."""
    parts = [p.strip().upper() for p in raw.split(",") if p.strip()]
    if not parts:
        raise ValueError("--origin must list at least one IATA code.")
    for p in parts:
        if not IATA_REGEX.match(p):
            raise ValueError(f"Invalid IATA in --origin list: {p!r}")
    return parts


_EXPLORE_CSV_ROW_RE = re.compile(r"^([A-Z]{3}),([A-Z]{3}),(\d+),")

# Earth radius in miles (matches src/lib/route-helpers.ts getHaversineDistance).
_HAVERSINE_EARTH_RADIUS_MILES = 3958.8


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in statute miles."""
    r1 = math.radians(lat1)
    r2 = math.radians(lat2)
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = math.sin(d_lat / 2) ** 2 + math.cos(r1) * math.cos(r2) * math.sin(d_lon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return _HAVERSINE_EARTH_RADIUS_MILES * c


def fetch_airports_latlon_by_iata(
    iata_codes: set[str],
    *,
    execute_max_attempts: int = 1,
    execute_retry_delay: float = 2.0,
    debug: bool = False,
) -> Dict[str, tuple[float, float]]:
    """
    Load latitude/longitude from Supabase `airports` for the given IATA codes (case-insensitive keys
    stored uppercase). Returns {} if supabase is missing, credentials are missing, or the query fails.
    Retries each chunk query on transient errors when execute_max_attempts > 1.
    """
    if not iata_codes:
        return {}
    try:
        from supabase import create_client
    except ImportError:
        return {}
    try:
        url, key = get_supabase_credentials()
    except ValueError:
        return {}

    client = create_client(url, key)
    codes_upper = sorted({c.strip().upper() for c in iata_codes if c and c.strip()})
    out: Dict[str, tuple[float, float]] = {}
    chunk_size = 120
    attempts = max(1, int(execute_max_attempts))
    delay = max(0.0, float(execute_retry_delay))
    for i in range(0, len(codes_upper), chunk_size):
        chunk = codes_upper[i : i + chunk_size]
        response = None
        for att in range(attempts):
            try:
                response = (
                    client.table("airports")
                    .select("iata,latitude,longitude")
                    .in_("iata", chunk)
                    .execute()
                )
                break
            except Exception as exc:
                if debug:
                    print(
                        f"[debug] airports lat/lon chunk retry {att + 1}/{attempts}: {type(exc).__name__}: {exc}",
                        file=sys.stderr,
                    )
                if att + 1 >= attempts:
                    response = None
                    break
                time.sleep(delay)
        if response is None:
            continue
        for row in getattr(response, "data", None) or []:
            code = (row.get("iata") or "").strip().upper()
            lat = row.get("latitude")
            lon = row.get("longitude")
            if not code or lat is None or lon is None:
                continue
            try:
                out[code] = (float(lat), float(lon))
            except (TypeError, ValueError):
                continue
    return out


def _format_cent_per_mile(price: int, miles: float) -> str:
    # price is USD; multiply USD-per-mile by 100 to store cents-per-mile.
    value = (price / miles) * 100.0
    text = f"{value:.10f}".rstrip("0").rstrip(".")
    return text if text else "0"


def attach_cent_per_mile_column(
    rows: List[str],
    origin_iata: str,
    latlon_by_iata: Dict[str, tuple[float, float]],
) -> List[str]:
    """
    Append `,cpm` (cent per mile = USD per effective mile * 100) when origin and destination both have
    coordinates in latlon_by_iata; otherwise leave the row as the original 5-field CSV.

    Effective miles: one-way great-circle distance; when the row's `roundtrip` column is the literal
    `roundtrip`, distance is doubled (out + return) for the per-mile denominator.
    """
    origin_key = origin_iata.strip().upper()
    origin_ll = latlon_by_iata.get(origin_key)
    attached: List[str] = []
    for line in rows:
        stripped = line.strip()
        match = _EXPLORE_CSV_ROW_RE.match(stripped)
        if not match:
            attached.append(line)
            continue
        dest_key = match.group(2)
        price = int(match.group(3))
        parts = stripped.split(",")
        if len(parts) != 5:
            attached.append(line)
            continue
        roundtrip_token = parts[3].strip().lower()
        j_token = parts[4].strip()
        if j_token != "j":
            attached.append(line)
            continue
        dest_ll = latlon_by_iata.get(dest_key)
        if origin_ll is None or dest_ll is None:
            attached.append(stripped)
            continue
        miles_one_way = haversine_miles(
            origin_ll[0], origin_ll[1], dest_ll[0], dest_ll[1]
        )
        if miles_one_way <= 0:
            attached.append(stripped)
            continue
        distance_multiplier = 2.0 if roundtrip_token == "roundtrip" else 1.0
        miles_for_cpm = miles_one_way * distance_multiplier
        cpm = _format_cent_per_mile(price, miles_for_cpm)
        # Sixth field is cpm (numeric; no currency symbol).
        attached.append(f"{stripped},{cpm}")
    return attached


def parse_explore_csv_row_for_supabase(line: str) -> Optional[Dict[str, Any]]:
    """
    Convert Explore CSV-ish lines into a Supabase row dict.

    Supports both 5-field and 6-field formats:
      origin,destination,price,roundtrip,j
      origin,destination,price,roundtrip,j,cpm
    """
    stripped = line.strip()
    if not stripped:
        return None
    if not _EXPLORE_CSV_ROW_RE.match(stripped):
        return None

    parts = stripped.split(",")
    if len(parts) not in (5, 6):
        return None

    origin_iata = parts[0].strip().upper()
    destination_iata = parts[1].strip().upper()
    price = int(parts[2])
    roundtrip = parts[3].strip()
    j = parts[4].strip()

    record: Dict[str, Any] = {
        "origin_iata": origin_iata,
        "destination_iata": destination_iata,
        "roundtrip": roundtrip,
        "j": j,
        "price": price,
    }

    if len(parts) == 6:
        cpm_s = parts[5].strip()
        try:
            cpm = float(cpm_s)
        except ValueError:
            cpm = None
        if cpm is not None:
            record["cpm"] = cpm

    return record


def upsert_explore_csv_rows_to_supabase(
    csv_lines: List[str],
    *,
    debug: bool,
) -> None:
    """
    Upsert Explore CSV-ish rows into `SUPABASE_EXPLORE_OUTPUT_TABLE`.

    Inserts/updates by `(origin_iata, destination_iata, roundtrip, j)`.
    """
    if not csv_lines:
        return

    try:
        from supabase import create_client
    except ImportError:
        if debug:
            print("Skipping Supabase upsert: missing dependency `supabase`.", file=sys.stderr)
        return

    try:
        url, key = get_supabase_write_credentials()
    except ValueError as error:
        if debug:
            print(f"Skipping Supabase upsert: {error}", file=sys.stderr)
        return

    records: List[Dict[str, Any]] = []
    for line in csv_lines:
        record = parse_explore_csv_row_for_supabase(line)
        if record:
            records.append(record)
    if not records:
        return

    client = create_client(url, key)
    chunk_size = max(1, int(SUPABASE_EXPLORE_UPSERT_CHUNK_SIZE))
    on_conflict = "origin_iata,destination_iata,roundtrip,j"

    for i in range(0, len(records), chunk_size):
        chunk = records[i : i + chunk_size]
        res = client.table(SUPABASE_EXPLORE_OUTPUT_TABLE).upsert(chunk, on_conflict=on_conflict).execute()
        status_code = 0
        if isinstance(res, dict):
            status_code = int(res.get("status_code", 200) or 200)
        if status_code >= 400:
            raise RuntimeError(f"Supabase upsert failed (status_code={status_code}): {res}")


def upsert_explore_output_after_step(
    step: ExploreStep,
    result: CaptureResult,
    *,
    rows_only: Optional[set[str]],
    rows_limit: int,
    supabase_attempts: int,
    supabase_retry_delay: float,
    debug: bool,
) -> bool:
    """
    After a successful Explore capture, parse the response body into CSV rows, attach `cpm` when
    coordinates exist, and upsert into `SUPABASE_EXPLORE_OUTPUT_TABLE`. Runs regardless of
    `--print-rows` / `--save-body`.

    Returns False if the Supabase upsert raised; True if skipped (no/empty body), nothing to write,
    or upsert succeeded.
    """
    raw_body = result.response.get("body")
    if not isinstance(raw_body, str) or raw_body == "":
        return True

    row_lines = parse_explore_body_to_rows(
        raw_body,
        origin_iata=step.origin_iata,
        rows_limit=-1,
        rows_only=rows_only,
    )
    merged = merge_explore_csv_rows(row_lines, rows_limit=rows_limit, rows_only=None)
    if not merged:
        return True

    try:
        iatas: set[str] = set()
        for row_line in merged:
            coord_match = _EXPLORE_CSV_ROW_RE.match(row_line.strip())
            if coord_match:
                iatas.add(coord_match.group(1))
                iatas.add(coord_match.group(2))
        latlon_map = fetch_airports_latlon_by_iata(
            iatas,
            execute_max_attempts=supabase_attempts,
            execute_retry_delay=supabase_retry_delay,
            debug=debug,
        )
        merged_by_origin: Dict[str, List[str]] = {}
        for row_line in merged:
            m2 = _EXPLORE_CSV_ROW_RE.match(row_line.strip())
            if m2:
                merged_by_origin.setdefault(m2.group(1), []).append(row_line)
        rebuilt: List[str] = []
        for o_code in sorted(merged_by_origin.keys()):
            rebuilt.extend(
                attach_cent_per_mile_column(merged_by_origin[o_code], o_code, latlon_map)
            )
        merged = rebuilt
    except Exception:
        pass

    try:
        upsert_explore_csv_rows_to_supabase(merged, debug=debug)
    except Exception as error:
        print(
            f"Supabase Explore row upsert failed ({step.origin_iata}->{step.destination_continent}): {error}",
            file=sys.stderr,
        )
        return False
    return True


def merge_explore_csv_rows(
    row_lines: List[str],
    rows_limit: int = -1,
    rows_only: Optional[set[str]] = None,
) -> List[str]:
    """
    Merge CSV lines `ORIG,DEST,PRICE,roundtrip,j` from multiple captures; keep minimum price per
    `(ORIG,DEST,roundtrip,j)` (matches Supabase upsert conflict target).
    """
    best_price: Dict[tuple[str, str, str, str], int] = {}
    for line in row_lines:
        stripped = line.strip()
        match = _EXPLORE_CSV_ROW_RE.match(stripped)
        if not match:
            continue
        origin_iata, dest_iata, price_s = match.group(1), match.group(2), match.group(3)
        if rows_only is not None and dest_iata not in rows_only:
            continue
        parts = stripped.split(",")
        if len(parts) < 5:
            continue
        roundtrip = parts[3].strip()
        j_field = parts[4].strip()
        price = int(price_s)
        key = (origin_iata, dest_iata, roundtrip, j_field)
        prev = best_price.get(key)
        if prev is None or price < prev:
            best_price[key] = price

    sorted_items = sorted(best_price.items(), key=lambda kv: kv[1])
    if rows_limit is not None and rows_limit != -1:
        sorted_items = sorted_items[: max(0, rows_limit)]

    return [f"{o},{d},{p},{rt},{jf}" for (o, d, rt, jf), p in sorted_items]


def save_body_path_for_region(base_path: str, region: str) -> str:
    """`./out/body.json` + region Europe -> `./out/body-europe.json`"""
    root, ext = os.path.splitext(base_path)
    if not ext:
        ext = ".json"
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", region.strip().lower()).strip("-") or "region"
    return f"{root}-{slug}{ext}"


def save_body_path_for_explore_step(
    base_path: str,
    step: ExploreStep,
    *,
    multi_origin: bool,
) -> str:
    """Disambiguate save paths when multiple origins share the same continent label."""
    root, ext = os.path.splitext(base_path)
    if not ext:
        ext = ".json"
    reg = re.sub(r"[^a-zA-Z0-9]+", "-", step.destination_continent.strip().lower()).strip("-") or "region"
    if not multi_origin:
        return f"{root}-{reg}{ext}"
    oslug = re.sub(r"[^a-zA-Z0-9]+", "-", step.origin_iata.strip().lower()).strip("-") or "origin"
    return f"{root}-{oslug}-{reg}{ext}"


def parse_explore_body_to_rows(
    body_text: Optional[str],
    origin_iata: str,
    rows_limit: int = -1,
    rows_only: Optional[set[str]] = None,
) -> list[str]:
    """
    Parse Google Travel Explore GetExploreDestinations response body into CSV rows:
      origin,destination,price,roundtrip,j
    (`attach_cent_per_mile_column` may add a 6th field: cpm uses effective miles = haversine mi,
    or 2x haversine when roundtrip=roundtrip, then price / effective_miles * 100.)

    Note: this is heuristic string parsing; it is designed to match the on-disk body format
    produced by this script's `--save-body`.
    """
    if not body_text:
        return []

    # Observed variants in the GetExploreDestinations payload:
    # - [[null,<PRICE>],\"CjRIX...
    # - [[null,<PRICE>],\"CjRIY...
    # We only need to anchor on the stable `[[null,<PRICE>],\"CjRI` prefix.
    price_marker_re = re.compile(r"\[\[null,(\d+)\],\\\"CjRI[A-Za-z]")
    escaped_iata_re = re.compile(r"\\\"([A-Z]{3})\\\"")

    best_price_by_iata: Dict[str, int] = {}
    for m in price_marker_re.finditer(body_text):
        price = int(m.group(1))
        window = body_text[m.end() : m.end() + 25000]
        cm = escaped_iata_re.search(window)
        if not cm:
            continue
        dest_iata = cm.group(1)
        if dest_iata == origin_iata:
            continue
        if rows_only is not None and dest_iata not in rows_only:
            continue
        prev = best_price_by_iata.get(dest_iata)
        if prev is None or price < prev:
            best_price_by_iata[dest_iata] = price

    rows_sorted = sorted(best_price_by_iata.items(), key=lambda kv: kv[1])
    if rows_limit is not None and rows_limit != -1:
        rows_sorted = rows_sorted[: max(0, rows_limit)]

    out: list[str] = []
    for dest_iata, price in rows_sorted:
        out.append(f"{origin_iata},{dest_iata},{price},roundtrip,j")
    return out


def main() -> int:
    args = parse_args()

    dest_raw = (args.destination or "").strip()

    try:
        origins = parse_origins_csv(args.origin)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    resume_raw = (args.resume_run_id or "").strip()
    if resume_raw:
        try:
            run_id = uuid.UUID(resume_raw)
        except ValueError:
            print(f"Invalid --resume-run-id (expected UUID): {resume_raw!r}", file=sys.stderr)
            return 2
    else:
        run_id = uuid.uuid4()
    print(f"explore_run_id={run_id}", file=sys.stderr)

    multi_origin_airports = len(origins) > 1

    try:
        destination: Optional[str] = normalize_explore_continent(dest_raw) if dest_raw else None
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    if args.manual:
        if multi_origin_airports:
            print("--manual supports only a single origin (no comma-separated list).", file=sys.stderr)
            return 2
        if not destination:
            print("--manual requires an explicit --destination continent.", file=sys.stderr)
            return 2

    supabase_attempts = max(1, 1 + max(0, int(SUPABASE_EXTRA_RETRIES)))
    supabase_retry_delay = max(0.0, float(SUPABASE_RETRY_DELAY_SECONDS))

    all_steps: List[ExploreStep] = []

    if args.manual:
        all_steps = [ExploreStep(origin_iata=origins[0], destination_continent=destination or "", mode="both")]
    elif not dest_raw:
        try:
            home_by: Dict[str, str] = {}

            def fetch_home_cached(code: str) -> str:
                c = code.strip().upper()
                if c not in home_by:
                    home_by[c] = run_with_retries(
                        f"Supabase airports.region[{c}]",
                        supabase_attempts,
                        supabase_retry_delay,
                        bool(args.debug),
                        lambda: fetch_airport_region_from_supabase(c),
                        should_retry=_should_retry_supabase_transient,
                    )
                return home_by[c]

            # Region plans are resolved per origin via MultiOriginExploreHandoffPlanner during capture:
            # each segment only needs the current and next airport (cached lookups), so the browser can
            # start after the first pair is known instead of waiting for every origin's Supabase row.
            all_steps = []  # filled segment-by-segment inside the capture loop
            if multi_origin_airports:
                print(
                    f"Auto multi-origin: {len(origins)} airport(s); handoff-safe continent order per origin "
                    f"(Supabase region for each airport loaded when that origin starts, plus the next).",
                    file=sys.stderr,
                )
            else:
                code = origins[0]
                fetch_home_cached(code)
                print(
                    f"Auto multi-region: origin {code!r} is in {home_by[code]!r}; "
                    f"will capture {len(allowed_explore_regions_for_home(home_by[code], AIRPORTS_SUPABASE_REGIONS_ORDERED))} "
                    f"regions in one session.",
                    file=sys.stderr,
                )
        except (ValueError, RuntimeError) as error:
            print(str(error), file=sys.stderr)
            return 2
        except Exception as error:
            print(f"Supabase region lookup failed after retries: {error}", file=sys.stderr)
            return 2
    else:
        assert destination is not None
        try:
            for code in origins:
                home = run_with_retries(
                    f"Supabase airports.region[{code}]",
                    supabase_attempts,
                    supabase_retry_delay,
                    bool(args.debug),
                    lambda c=code: fetch_airport_region_from_supabase(c),
                    should_retry=_should_retry_supabase_transient,
                )
                if home == destination:
                    print(
                        f"Origin {code!r} is in {destination!r}; that continent cannot be the Explore destination.",
                        file=sys.stderr,
                    )
                    return 2
        except (ValueError, RuntimeError) as error:
            print(str(error), file=sys.stderr)
            return 2
        except Exception as error:
            print(f"Supabase region lookup failed after retries: {error}", file=sys.stderr)
            return 2
        if multi_origin_airports:
            all_steps = build_explore_steps_explicit_destination(origins, destination)
        else:
            all_steps = [ExploreStep(origin_iata=origins[0], destination_continent=destination, mode="both")]

    explore_auto_lazy = not args.manual and not dest_raw

    if not args.manual and not explore_auto_lazy and not all_steps:
        print("No Explore steps to run.", file=sys.stderr)
        return 2

    steps_to_run: List[ExploreStep] = []
    if args.manual:
        steps_to_run = all_steps[:]
    elif not explore_auto_lazy:
        done_keys = fetch_successful_pairing_keys(run_id, debug=bool(args.debug))
        steps_to_run = [
            s for s in all_steps if (s.origin_iata, s.destination_continent) not in done_keys
        ]
    if not args.manual and not explore_auto_lazy and not steps_to_run and all_steps:
        print(
            f"All {len(all_steps)} pairing(s) already marked success in DB; nothing to do (run_id={run_id}).",
            file=sys.stderr,
        )
        return 0

    first_destination = (
        steps_to_run[0].destination_continent
        if steps_to_run
        else (all_steps[0].destination_continent if all_steps else "")
    )
    capture_extra = max(0, int(CAPTURE_EXTRA_RETRIES))
    total_capture_attempts = max(1, 1 + capture_extra)
    capture_retry_delay = max(0.0, float(CAPTURE_RETRY_DELAY_SECONDS))

    last_capture_error: Optional[BaseException] = None
    for capture_try in range(1, total_capture_attempts + 1):
        if explore_auto_lazy:
            assert not args.manual
            done_keys_lazy = fetch_successful_pairing_keys(run_id, debug=bool(args.debug))
            planner = MultiOriginExploreHandoffPlanner(origins, fetch_home_cached)
            all_steps = []
            capturer: Optional[GoogleFlightsCalendarCapture] = None
            session_exit_code: Optional[int] = None
            executed_results: List[tuple[ExploreStep, CaptureResult]] = []
            explore_output_upsert_ok = True
            try:
                rows_only_lazy: Optional[set[str]] = None
                if args.rows_only:
                    rows_only_lazy = {
                        x.strip().upper() for x in args.rows_only.split(",") if x.strip()
                    }
                consecutive_origin_failures = 0
                while True:
                    try:
                        o_idx, code, plan = planner.next_segment()
                    except StopIteration:
                        break
                    if bool(args.debug):
                        print(f"[debug] region plan {code}: {plan}", file=sys.stderr)
                    seg = build_explore_steps_for_origin_index(code, o_idx, plan)
                    all_steps.extend(seg)
                    pending = [
                        s
                        for s in seg
                        if (s.origin_iata, s.destination_continent) not in done_keys_lazy
                    ]
                    if not pending:
                        continue
                    if capturer is None:
                        capturer = GoogleFlightsCalendarCapture(
                            origin=pending[0].origin_iata,
                            destination=pending[0].destination_continent,
                            timeout_seconds=max(5, int(CAPTURE_TIMEOUT_SECONDS)),
                            headless=bool(args.headless),
                            debug=bool(args.debug),
                        )
                        capturer.bootstrap_explore_session()
                    for i, step in enumerate(pending):
                        try:
                            res = capturer.capture_planned_step(step)
                            executed_results.append((step, res))
                            upsert_explore_pairing_status(
                                run_id,
                                step.origin_iata,
                                step.destination_continent,
                                "success",
                                debug=bool(args.debug),
                            )
                            if not upsert_explore_output_after_step(
                                step,
                                res,
                                rows_only=rows_only_lazy,
                                rows_limit=int(args.rows_limit),
                                supabase_attempts=supabase_attempts,
                                supabase_retry_delay=supabase_retry_delay,
                                debug=bool(args.debug),
                            ):
                                explore_output_upsert_ok = False
                            consecutive_origin_failures = 0
                        except BaseException as step_error:
                            upsert_explore_pairing_status(
                                run_id,
                                step.origin_iata,
                                step.destination_continent,
                                "failed",
                                error_message=str(step_error),
                                debug=bool(args.debug),
                            )
                            if multi_origin_airports and _is_explore_origin_not_set_error(
                                step_error
                            ):
                                print(f"{step.origin_iata} - failed", file=sys.stderr)
                                consecutive_origin_failures += 1
                                skip_msg = (
                                    "skipped: origin not set for this airport "
                                    "(earlier step on same origin failed)"
                                )
                                for skipped in pending[i + 1 :]:
                                    upsert_explore_pairing_status(
                                        run_id,
                                        skipped.origin_iata,
                                        skipped.destination_continent,
                                        "failed",
                                        error_message=skip_msg,
                                        debug=bool(args.debug),
                                    )
                                if (
                                    consecutive_origin_failures
                                    >= EXPLORE_CONSECUTIVE_ORIGIN_FAILURES_BEFORE_SESSION_RETRY
                                ):
                                    raise TimeoutException(
                                        "Explore: "
                                        f"{EXPLORE_CONSECUTIVE_ORIGIN_FAILURES_BEFORE_SESSION_RETRY} "
                                        "consecutive airports failed origin set; retrying browser session."
                                    ) from step_error
                                break
                            raise

                if capturer is None:
                    if all_steps:
                        print(
                            f"All {len(all_steps)} pairing(s) already marked success in DB; nothing to do (run_id={run_id}).",
                            file=sys.stderr,
                        )
                        return 0
                    print("No Explore steps to run.", file=sys.stderr)
                    return 2

                if args.print_rows:
                    all_row_lines_lazy: List[str] = []
                    for step, result in executed_results:
                        raw_body = result.response.get("body")
                        if args.save_body:
                            if multi_origin_airports:
                                save_path = save_body_path_for_explore_step(
                                    args.save_body, step, multi_origin=True
                                )
                            elif len(all_steps) > 1:
                                save_path = save_body_path_for_region(
                                    args.save_body, step.destination_continent
                                )
                            else:
                                save_path = args.save_body
                            save_response_body_to_path(
                                save_path, raw_body if isinstance(raw_body, str) else None
                            )
                            n = len(raw_body) if isinstance(raw_body, str) else 0
                            print(
                                f"Saved response body to {os.path.abspath(save_path)} ({n} chars) "
                                f"[{step.origin_iata} -> {step.destination_continent}]",
                                file=sys.stderr,
                            )
                        if not isinstance(raw_body, str) or raw_body == "":
                            print(
                                f"No response body for {step.origin_iata!r} -> {step.destination_continent!r}; "
                                "skipping parse for that step.",
                                file=sys.stderr,
                            )
                            continue
                        all_row_lines_lazy.extend(
                            parse_explore_body_to_rows(
                                raw_body,
                                origin_iata=step.origin_iata,
                                rows_limit=-1,
                                rows_only=rows_only_lazy,
                            )
                        )

                    merged_rows_lazy = merge_explore_csv_rows(
                        all_row_lines_lazy,
                        rows_limit=int(args.rows_limit),
                        rows_only=None,
                    )
                    if not merged_rows_lazy:
                        print(
                            "Parsed 0 rows from response body (after merge). "
                            "This usually means Google returned an unexpected payload shape. "
                            "Run with --debug and/or also try --save-body to inspect.",
                            file=sys.stderr,
                        )
                        session_exit_code = 2
                    else:
                        try:
                            iatas_lazy: set[str] = set()
                            for row_line in merged_rows_lazy:
                                coord_match = _EXPLORE_CSV_ROW_RE.match(row_line.strip())
                                if coord_match:
                                    iatas_lazy.add(coord_match.group(1))
                                    iatas_lazy.add(coord_match.group(2))
                            latlon_map_lazy = fetch_airports_latlon_by_iata(
                                iatas_lazy,
                                execute_max_attempts=supabase_attempts,
                                execute_retry_delay=supabase_retry_delay,
                                debug=bool(args.debug),
                            )
                            merged_by_origin_lazy: Dict[str, List[str]] = {}
                            for row_line in merged_rows_lazy:
                                m2 = _EXPLORE_CSV_ROW_RE.match(row_line.strip())
                                if m2:
                                    merged_by_origin_lazy.setdefault(m2.group(1), []).append(row_line)
                            rebuilt_lazy: List[str] = []
                            for o_code in sorted(merged_by_origin_lazy.keys()):
                                part = attach_cent_per_mile_column(
                                    merged_by_origin_lazy[o_code], o_code, latlon_map_lazy
                                )
                                rebuilt_lazy.extend(part)
                            merged_rows_lazy = rebuilt_lazy
                        except Exception:
                            pass

                        for line in merged_rows_lazy:
                            print(line)
                        session_exit_code = 0 if explore_output_upsert_ok else 1
                else:
                    if args.save_body:
                        for step, result in executed_results:
                            raw_body = result.response.get("body")
                            if not multi_origin_airports and len(all_steps) > 1:
                                save_path = save_body_path_for_region(
                                    args.save_body, step.destination_continent
                                )
                            elif multi_origin_airports:
                                save_path = save_body_path_for_explore_step(
                                    args.save_body, step, multi_origin=True
                                )
                            else:
                                save_path = args.save_body
                            if not isinstance(raw_body, str) or raw_body == "":
                                print(
                                    f"Warning: response body missing for {step.origin_iata}->"
                                    f"{step.destination_continent}; file was still written.",
                                    file=sys.stderr,
                                )
                            save_response_body_to_path(
                                save_path, raw_body if isinstance(raw_body, str) else None
                            )
                            n = len(raw_body) if isinstance(raw_body, str) else 0
                            print(
                                f"Saved response body to {os.path.abspath(save_path)} ({n} chars)",
                                file=sys.stderr,
                            )

                    session_exit_code = 0 if explore_output_upsert_ok else 1
            except TimeoutException as error:
                last_capture_error = error
                print(str(error), file=sys.stderr)
            except KeyboardInterrupt:
                raise
            except Exception as error:
                last_capture_error = error
                print(f"Capture failed: {error}", file=sys.stderr)
            finally:
                if capturer is not None:
                    capturer.close()

            if session_exit_code is not None:
                return session_exit_code

            if capture_try < total_capture_attempts:
                print(
                    f"[retry] capture: sleeping {capture_retry_delay}s before attempt "
                    f"{capture_try + 1}/{total_capture_attempts}",
                    file=sys.stderr,
                )
                time.sleep(capture_retry_delay)
            continue

        first_origin_iata = steps_to_run[0].origin_iata if steps_to_run else origins[0]
        capturer = GoogleFlightsCalendarCapture(
            origin=first_origin_iata,
            destination=first_destination,
            timeout_seconds=max(5, int(CAPTURE_TIMEOUT_SECONDS)),
            headless=bool(args.headless),
            debug=bool(args.debug),
        )
        session_exit_code = None
        explore_output_upsert_ok = True
        try:
            rows_only: Optional[set[str]] = None
            if args.rows_only:
                rows_only = {x.strip().upper() for x in args.rows_only.split(",") if x.strip()}

            if args.manual:
                result = capturer.run_manual()
                executed_results = [(all_steps[0], result)]
                if not upsert_explore_output_after_step(
                    all_steps[0],
                    result,
                    rows_only=rows_only,
                    rows_limit=int(args.rows_limit),
                    supabase_attempts=supabase_attempts,
                    supabase_retry_delay=supabase_retry_delay,
                    debug=bool(args.debug),
                ):
                    explore_output_upsert_ok = False
            else:
                capturer.bootstrap_explore_session()
                executed_results = []
                consecutive_origin_failures_nl = 0
                step_idx_nl = 0
                while step_idx_nl < len(steps_to_run):
                    step = steps_to_run[step_idx_nl]
                    try:
                        res = capturer.capture_planned_step(step)
                        executed_results.append((step, res))
                        upsert_explore_pairing_status(
                            run_id,
                            step.origin_iata,
                            step.destination_continent,
                            "success",
                            debug=bool(args.debug),
                        )
                        if not upsert_explore_output_after_step(
                            step,
                            res,
                            rows_only=rows_only,
                            rows_limit=int(args.rows_limit),
                            supabase_attempts=supabase_attempts,
                            supabase_retry_delay=supabase_retry_delay,
                            debug=bool(args.debug),
                        ):
                            explore_output_upsert_ok = False
                        consecutive_origin_failures_nl = 0
                    except BaseException as step_error:
                        upsert_explore_pairing_status(
                            run_id,
                            step.origin_iata,
                            step.destination_continent,
                            "failed",
                            error_message=str(step_error),
                            debug=bool(args.debug),
                        )
                        if multi_origin_airports and _is_explore_origin_not_set_error(
                            step_error
                        ):
                            print(f"{step.origin_iata} - failed", file=sys.stderr)
                            consecutive_origin_failures_nl += 1
                            skip_msg = (
                                "skipped: origin not set for this airport "
                                "(earlier step on same origin failed)"
                            )
                            j = step_idx_nl + 1
                            while j < len(steps_to_run) and (
                                steps_to_run[j].origin_iata == step.origin_iata
                            ):
                                upsert_explore_pairing_status(
                                    run_id,
                                    steps_to_run[j].origin_iata,
                                    steps_to_run[j].destination_continent,
                                    "failed",
                                    error_message=skip_msg,
                                    debug=bool(args.debug),
                                )
                                j += 1
                            step_idx_nl = j
                            if (
                                consecutive_origin_failures_nl
                                >= EXPLORE_CONSECUTIVE_ORIGIN_FAILURES_BEFORE_SESSION_RETRY
                            ):
                                raise TimeoutException(
                                    "Explore: "
                                    f"{EXPLORE_CONSECUTIVE_ORIGIN_FAILURES_BEFORE_SESSION_RETRY} "
                                    "consecutive airports failed origin set; retrying browser session."
                                ) from step_error
                            continue
                        raise
                    step_idx_nl += 1

            if args.print_rows:
                all_row_lines: List[str] = []
                for step, result in executed_results:
                    raw_body = result.response.get("body")
                    if args.save_body:
                        if multi_origin_airports:
                            save_path = save_body_path_for_explore_step(
                                args.save_body, step, multi_origin=True
                            )
                        elif len(all_steps) > 1:
                            save_path = save_body_path_for_region(
                                args.save_body, step.destination_continent
                            )
                        else:
                            save_path = args.save_body
                        save_response_body_to_path(
                            save_path, raw_body if isinstance(raw_body, str) else None
                        )
                        n = len(raw_body) if isinstance(raw_body, str) else 0
                        print(
                            f"Saved response body to {os.path.abspath(save_path)} ({n} chars) "
                            f"[{step.origin_iata} -> {step.destination_continent}]",
                            file=sys.stderr,
                        )
                    if not isinstance(raw_body, str) or raw_body == "":
                        print(
                            f"No response body for {step.origin_iata!r} -> {step.destination_continent!r}; "
                            "skipping parse for that step.",
                            file=sys.stderr,
                        )
                        continue
                    all_row_lines.extend(
                        parse_explore_body_to_rows(
                            raw_body,
                            origin_iata=step.origin_iata,
                            rows_limit=-1,
                            rows_only=rows_only,
                        )
                    )

                merged_rows = merge_explore_csv_rows(
                    all_row_lines,
                    rows_limit=int(args.rows_limit),
                    rows_only=None,
                )
                if not merged_rows:
                    print(
                        "Parsed 0 rows from response body (after merge). "
                        "This usually means Google returned an unexpected payload shape. "
                        "Run with --debug and/or also try --save-body to inspect.",
                        file=sys.stderr,
                    )
                    session_exit_code = 2
                else:
                    try:
                        iatas_for_coords: set[str] = set()
                        for row_line in merged_rows:
                            coord_match = _EXPLORE_CSV_ROW_RE.match(row_line.strip())
                            if coord_match:
                                iatas_for_coords.add(coord_match.group(1))
                                iatas_for_coords.add(coord_match.group(2))
                        latlon_map = fetch_airports_latlon_by_iata(
                            iatas_for_coords,
                            execute_max_attempts=supabase_attempts,
                            execute_retry_delay=supabase_retry_delay,
                            debug=bool(args.debug),
                        )
                        merged_by_origin: Dict[str, List[str]] = {}
                        for row_line in merged_rows:
                            m2 = _EXPLORE_CSV_ROW_RE.match(row_line.strip())
                            if m2:
                                merged_by_origin.setdefault(m2.group(1), []).append(row_line)
                        rebuilt: List[str] = []
                        for o_code in sorted(merged_by_origin.keys()):
                            part = attach_cent_per_mile_column(
                                merged_by_origin[o_code], o_code, latlon_map
                            )
                            rebuilt.extend(part)
                        merged_rows = rebuilt
                    except Exception:
                        pass

                    for line in merged_rows:
                        print(line)
                    session_exit_code = 0 if explore_output_upsert_ok else 1
            else:
                if args.save_body:
                    for step, result in executed_results:
                        raw_body = result.response.get("body")
                        if not multi_origin_airports and len(all_steps) > 1:
                            save_path = save_body_path_for_region(
                                args.save_body, step.destination_continent
                            )
                        elif multi_origin_airports:
                            save_path = save_body_path_for_explore_step(
                                args.save_body, step, multi_origin=True
                            )
                        else:
                            save_path = args.save_body
                        if not isinstance(raw_body, str) or raw_body == "":
                            print(
                                f"Warning: response body missing for {step.origin_iata}->{step.destination_continent}; "
                                "file was still written.",
                                file=sys.stderr,
                            )
                        save_response_body_to_path(
                            save_path, raw_body if isinstance(raw_body, str) else None
                        )
                        n = len(raw_body) if isinstance(raw_body, str) else 0
                        print(
                            f"Saved response body to {os.path.abspath(save_path)} ({n} chars)",
                            file=sys.stderr,
                        )

                session_exit_code = 0 if explore_output_upsert_ok else 1
        except TimeoutException as error:
            last_capture_error = error
            print(str(error), file=sys.stderr)
        except KeyboardInterrupt:
            raise
        except Exception as error:
            last_capture_error = error
            print(f"Capture failed: {error}", file=sys.stderr)
        finally:
            capturer.close()

        if session_exit_code is not None:
            return session_exit_code

        if capture_try < total_capture_attempts:
            print(
                f"[retry] capture: sleeping {capture_retry_delay}s before attempt "
                f"{capture_try + 1}/{total_capture_attempts}",
                file=sys.stderr,
            )
            time.sleep(capture_retry_delay)
            if not args.manual and not explore_auto_lazy:
                done_keys = fetch_successful_pairing_keys(run_id, debug=bool(args.debug))
                steps_to_run = [
                    s for s in all_steps if (s.origin_iata, s.destination_continent) not in done_keys
                ]
                if not steps_to_run and all_steps:
                    return 0

    if isinstance(last_capture_error, TimeoutException):
        print(str(last_capture_error), file=sys.stderr)
        return 1
    if last_capture_error is not None:
        print(f"Capture failed: {last_capture_error}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
