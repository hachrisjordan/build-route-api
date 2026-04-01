#!/usr/bin/env python3
"""
Google Flights Min/Max Validator

Workflow:
1) Load candidate rows from google_flights_explore_destination_prices
   - destination has known region (via airports table)
   - optional filter: only rows with existing min_price/max_price
   - sorted by cpm ascending
2) Build Google Flights links in the requested readable q= format
3) Open each link in undetected-chromedriver
4) Intercept FlightsFrontendUi responses and extract min/max fares
5) Update min_price, max_price, percentage for each row by id

percentage: 0 inside [min,max]; negative below min (% under min); positive above max (% over max).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote

from dotenv import load_dotenv
from selenium.common.exceptions import NoSuchWindowException, WebDriverException
from supabase import Client, create_client


TARGET_PREFIX = (
    "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights."
)
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FARE_TOKEN_RE = re.compile(r"\[\[\s*null\s*,\s*(\d{3,6})\s*\]\s*,\s*\"Cj")
NULL_PRICE_RE = re.compile(r"\[\s*null\s*,\s*(\d{3,6})\s*\]")
MINMAX_NAMED_RE = re.compile(
    r"(?:min[_ ]?price|max[_ ]?price|minimum|maximum)[^0-9]{0,20}(\d{3,6})",
    re.IGNORECASE,
)
MINMAX_PAIR_RE = re.compile(
    r"\[\[\s*null\s*,\s*(\d{3,6})\s*\]\s*,\s*\[\s*null\s*,\s*(\d{3,6})\s*\]\]"
)
MINMAX_META_RE = re.compile(
    r"\[\s*5\s*,\s*\[\s*null\s*,\s*(\d{3,6})\s*\]\s*,\s*\[\s*null\s*,\s*(\d{3,6})\s*\]"
)


def patch_distutils_and_import_uc():
    try:
        import undetected_chromedriver as uc  # type: ignore

        return uc
    except ImportError as error:
        if "distutils" not in str(error):
            raise
        import types

        shim = types.ModuleType("distutils")
        shim.version = types.ModuleType("distutils.version")

        class LooseVersion:
            def __init__(self, version_string: str) -> None:
                self.version = str(version_string)

            def __str__(self) -> str:
                return self.version

        shim.version.LooseVersion = LooseVersion  # type: ignore[attr-defined]
        sys.modules["distutils"] = shim
        sys.modules["distutils.version"] = shim.version
        import undetected_chromedriver as uc  # type: ignore

        return uc


uc = patch_distutils_and_import_uc()


@dataclass
class RouteRow:
    id: str
    origin_iata: str
    destination_iata: str
    roundtrip: str
    price: Optional[int]
    cpm: Optional[float]
    depart_date: Optional[str]
    arrive_date: Optional[str]
    min_price: Optional[int]
    max_price: Optional[int]


class MinMaxValidator:
    def __init__(
        self,
        *,
        headless: bool,
        limit: int,
        timeout: int,
        dry_run: bool,
        origin_filter: Optional[str],
        destination_filter: Optional[str],
        baseline_requires_existing_minmax: bool,
        retries_per_route: int,
        dump_body_on_fail: bool,
    ) -> None:
        self.headless = headless
        self.limit = limit
        self.timeout = timeout
        self.dry_run = dry_run
        self.origin_filter = origin_filter.upper() if origin_filter else None
        self.destination_filter = destination_filter.upper() if destination_filter else None
        self.baseline_requires_existing_minmax = baseline_requires_existing_minmax
        self.retries_per_route = max(1, retries_per_route)
        self.dump_body_on_fail = dump_body_on_fail

        self.supabase = self._build_supabase_client()
        self.driver = None
        self._requests: Dict[str, Dict[str, Any]] = {}

        self.processed = 0
        self.intercepted = 0
        self.updated = 0
        self.skipped = 0
        self.parse_failed = 0

    def _build_supabase_client(self) -> Client:
        url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise RuntimeError("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
        return create_client(url, key)

    def _detect_chrome_version_main(self, chrome_bin: Optional[str]) -> Optional[int]:
        if not chrome_bin:
            return None
        try:
            out = subprocess.check_output([chrome_bin, "--version"], stderr=subprocess.STDOUT).decode("utf-8", errors="ignore")
            match = re.search(r"(\d+)\.", out)
            return int(match.group(1)) if match else None
        except Exception:
            return None

    def _pick_chrome_bin(self) -> Optional[str]:
        env_bin = os.getenv("CHROME_BIN")
        if env_bin and os.path.exists(env_bin):
            return env_bin
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
        ]
        for path in candidates:
            if os.path.exists(path):
                return path
        return None

    def setup_driver(self) -> None:
        options = uc.ChromeOptions()
        chrome_bin = self._pick_chrome_bin()
        if chrome_bin:
            options.binary_location = chrome_bin

        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument("--disable-extensions")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_argument("--window-size=1440,1200")
        options.add_argument("--lang=en-US")
        options.set_capability("goog:loggingPrefs", {"performance": "ALL"})

        profile_dir = os.getenv("CHROME_DATA_DIR") or "/tmp/chrome-data"
        options.add_argument(f"--user-data-dir={profile_dir}")
        options.add_argument("--profile-directory=Default")
        options.add_argument("--no-first-run")
        options.add_argument("--no-default-browser-check")
        if self.headless:
            options.add_argument("--headless=new")

        version_main = self._detect_chrome_version_main(chrome_bin)
        self.driver = uc.Chrome(options=options, headless=self.headless, version_main=version_main)
        self.driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        self.driver.execute_cdp_cmd("Network.enable", {})

    def close(self) -> None:
        if self.driver is None:
            return
        try:
            self.driver.quit()
        except Exception:
            pass
        self.driver = None

    def fetch_candidates(self) -> List[RouteRow]:
        rows: List[RouteRow] = []
        page_size = 1000
        from_idx = 0

        airport_region_cache = self._load_airport_region_map()
        while len(rows) < self.limit:
            to_idx = from_idx + page_size - 1
            query = (
                self.supabase.table("google_flights_explore_destination_prices")
                .select("id,origin_iata,destination_iata,roundtrip,price,cpm,departDate,arriveDate,min_price,max_price")
                .order("cpm", desc=False, nullsfirst=False)
                .range(from_idx, to_idx)
            )
            result = query.execute()
            data = result.data or []
            if not data:
                break

            for row in data:
                origin = str(row.get("origin_iata") or "").strip().upper()
                dest = str(row.get("destination_iata") or "").strip().upper()
                if not origin or not dest:
                    continue
                if self.origin_filter and origin != self.origin_filter:
                    continue
                if self.destination_filter and dest != self.destination_filter:
                    continue

                region = airport_region_cache.get(dest)
                if not region or region.lower() == "unknown":
                    continue

                min_price = self._to_int(row.get("min_price"))
                max_price = self._to_int(row.get("max_price"))
                if self.baseline_requires_existing_minmax and (min_price is None or max_price is None):
                    continue

                route = RouteRow(
                    id=str(row.get("id")),
                    origin_iata=origin,
                    destination_iata=dest,
                    roundtrip=str(row.get("roundtrip") or "oneway").strip().lower(),
                    price=self._to_int(row.get("price")),
                    cpm=self._to_float(row.get("cpm")),
                    depart_date=self._to_iso_date(row.get("departDate")),
                    arrive_date=self._to_iso_date(row.get("arriveDate")),
                    min_price=min_price,
                    max_price=max_price,
                )
                rows.append(route)
                if len(rows) >= self.limit:
                    break

            if len(data) < page_size:
                break
            from_idx += page_size

        return rows

    def _load_airport_region_map(self) -> Dict[str, str]:
        mapping: Dict[str, str] = {}
        page_size = 2000
        from_idx = 0
        while True:
            to_idx = from_idx + page_size - 1
            result = self.supabase.table("airports").select("iata,region").range(from_idx, to_idx).execute()
            data = result.data or []
            if not data:
                break
            for row in data:
                iata = str(row.get("iata") or "").strip().upper()
                region = str(row.get("region") or "").strip()
                if iata:
                    mapping[iata] = region
            if len(data) < page_size:
                break
            from_idx += page_size
        return mapping

    def build_google_flights_url(self, route: RouteRow) -> str:
        depart = route.depart_date or self._default_depart_date()
        pieces = [f"flights from {route.origin_iata} to {route.destination_iata} on {depart}"]
        if route.roundtrip == "roundtrip":
            arrive = route.arrive_date or self._add_days_utc(depart, 7)
            pieces.append(f"through {arrive}")
        pieces.append("business class")
        q = " ".join(pieces)
        return f"https://www.google.com/travel/flights?q={quote(q, safe='')}"

    def _clear_request_cache(self) -> None:
        self._requests = {}

    def _capture_flightsfrontend_bodies(self, url: str) -> List[str]:
        assert self.driver is not None
        self._clear_request_cache()
        self.driver.get(url)
        deadline = time.time() + self.timeout
        candidate_request_ids: List[str] = []
        bodies: List[str] = []

        while time.time() < deadline:
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
                    req_url = str(params.get("request", {}).get("url", ""))
                    if request_id and req_url.startswith(TARGET_PREFIX):
                        self._requests[request_id] = {"url": req_url}

                elif method == "Network.responseReceived":
                    request_id = params.get("requestId")
                    if request_id in self._requests:
                        candidate_request_ids.append(request_id)

                elif method == "Network.loadingFinished":
                    request_id = params.get("requestId")
                    if request_id in self._requests:
                        body = self._poll_response_body_stable(request_id)
                        if body:
                            bodies.append(body)
            if candidate_request_ids:
                for request_id in candidate_request_ids[-5:]:
                    body = self._poll_response_body_stable(request_id)
                    if body:
                        bodies.append(body)
            time.sleep(0.25)
        # Deduplicate while preserving order.
        unique: List[str] = []
        seen = set()
        for body in bodies:
            if body in seen:
                continue
            seen.add(body)
            unique.append(body)
        return unique

    def _poll_response_body_stable(self, request_id: str) -> Optional[str]:
        assert self.driver is not None
        deadline = time.time() + max(10, self.timeout)
        last: Optional[str] = None
        stable_count = 0
        while time.time() < deadline:
            try:
                payload = self.driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": request_id})
                body = payload.get("body", "")
                if payload.get("base64Encoded"):
                    body = base64.b64decode(body).decode("utf-8", errors="replace")
                body = body if isinstance(body, str) else str(body)
            except NoSuchWindowException:
                return None
            except WebDriverException:
                time.sleep(0.2)
                continue
            except Exception:
                time.sleep(0.2)
                continue

            if not body:
                time.sleep(0.2)
                continue
            if body == last:
                stable_count += 1
                if stable_count >= 2:
                    return body
            else:
                last = body
                stable_count = 1
            time.sleep(0.2)
        return last

    def extract_min_max(self, body: str, route: RouteRow) -> Optional[Tuple[int, int]]:
        # Ignore app-manifest/bootstrap payloads accidentally captured from non-data endpoints.
        if body.lstrip().startswith("{\"name\":\"Google Flights\""):
            return None
        pair_hits: List[Tuple[int, int]] = []
        for m in MINMAX_PAIR_RE.finditer(body):
            a, b = int(m.group(1)), int(m.group(2))
            low, high = (a, b) if a <= b else (b, a)
            if 1000 <= low <= 50000 and 1000 <= high <= 50000:
                pair_hits.append((low, high))
        for m in MINMAX_META_RE.finditer(body):
            a, b = int(m.group(1)), int(m.group(2))
            low, high = (a, b) if a <= b else (b, a)
            if 1000 <= low <= 50000 and 1000 <= high <= 50000:
                pair_hits.append((low, high))
        if pair_hits:
            # Prefer the tightest plausible pair to avoid broad envelope ranges.
            pair_hits.sort(key=lambda p: (p[1] - p[0], p[1]))
            return pair_hits[0]

        named_hits = [int(m.group(1)) for m in MINMAX_NAMED_RE.finditer(body)]
        named_hits = [v for v in named_hits if 100 <= v <= 50000]
        if len(named_hits) >= 2:
            return min(named_hits), max(named_hits)

        route_prices = self._extract_route_prices(body, route.destination_iata)
        if route_prices:
            return min(route_prices), max(route_prices)

        all_prices = [int(m.group(1)) for m in FARE_TOKEN_RE.finditer(body)]
        all_prices = [v for v in all_prices if 300 <= v <= 50000]
        if len(all_prices) >= 2:
            return min(all_prices), max(all_prices)
        return None

    def _extract_route_prices(self, body: str, destination_iata: str) -> List[int]:
        prices: List[int] = []
        token = f"\"{destination_iata}\""
        start = 0
        while True:
            idx = body.find(token, start)
            if idx < 0:
                break
            win_start = max(0, idx - 2400)
            win_end = min(len(body), idx + 2400)
            window = body[win_start:win_end]
            for match in FARE_TOKEN_RE.finditer(window):
                value = int(match.group(1))
                if 300 <= value <= 50000:
                    prices.append(value)
            if not prices:
                for match in NULL_PRICE_RE.finditer(window):
                    value = int(match.group(1))
                    # Guard out tiny metadata IDs/indices.
                    if 1000 <= value <= 50000:
                        prices.append(value)
            start = idx + len(token)
        if prices:
            return sorted(set(prices))
        return []

    def compute_percentage(self, db_price: int, min_price: int, max_price: int) -> float:
        if db_price < min_price:
            return -((min_price - db_price) / float(min_price)) * 100.0
        if db_price > max_price:
            return ((db_price - max_price) / float(max_price)) * 100.0
        return 0.0

    def update_row(self, route: RouteRow, min_price: int, max_price: int, percentage: float) -> None:
        patch = {
            "min_price": min_price,
            "max_price": max_price,
            "percentage": round(percentage, 4),
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if self.dry_run:
            print(
                f"[DRY-RUN] id={route.id} {route.origin_iata}-{route.destination_iata} "
                f"db_price={route.price} min={min_price} max={max_price} percentage={patch['percentage']}"
            )
            return
        self.supabase.table("google_flights_explore_destination_prices").update(patch).eq("id", route.id).execute()

    def run(self) -> None:
        self.setup_driver()
        candidates = self.fetch_candidates()
        print(f"[validator] candidates={len(candidates)} dry_run={self.dry_run}")

        for route in candidates:
            self.processed += 1
            if route.price is None or route.price <= 0:
                self.skipped += 1
                continue

            url = self.build_google_flights_url(route)
            bodies: List[str] = []
            for attempt in range(1, self.retries_per_route + 1):
                bodies = self._capture_flightsfrontend_bodies(url)
                if bodies:
                    break
                if attempt < self.retries_per_route:
                    time.sleep(1.0)
            if not bodies:
                self.parse_failed += 1
                print(f"[warn] no FlightsFrontendUi body for {route.origin_iata}-{route.destination_iata}")
                continue

            self.intercepted += 1
            extracted: Optional[Tuple[int, int]] = None
            best_span: Optional[int] = None
            best_body: Optional[str] = None
            for body in bodies:
                candidate = self.extract_min_max(body, route)
                if not candidate:
                    continue
                low, high = candidate
                span = high - low
                if span < 0:
                    continue
                if best_span is None or span < best_span:
                    best_span = span
                    extracted = candidate
                    best_body = body
            if not extracted:
                self.parse_failed += 1
                print(f"[warn] unable to parse min/max for {route.origin_iata}-{route.destination_iata}")
                if self.dump_body_on_fail:
                    self._dump_failed_body(route, url, bodies[-1])
                continue

            min_price, max_price = extracted
            if min_price <= 0 or max_price <= 0 or min_price > max_price:
                self.parse_failed += 1
                print(f"[warn] invalid min/max ({min_price}, {max_price}) for {route.origin_iata}-{route.destination_iata}")
                if self.dump_body_on_fail and best_body:
                    self._dump_failed_body(route, url, best_body)
                continue

            pct = self.compute_percentage(route.price, min_price, max_price)
            self.update_row(route, min_price, max_price, pct)
            self.updated += 1

        self._print_summary()

    def _print_summary(self) -> None:
        print("[validator] summary")
        print(f"[validator] processed={self.processed}")
        print(f"[validator] intercepted={self.intercepted}")
        print(f"[validator] updated={self.updated}")
        print(f"[validator] skipped={self.skipped}")
        print(f"[validator] parse_failed={self.parse_failed}")

    def _dump_failed_body(self, route: RouteRow, url: str, body: str) -> None:
        ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        out_dir = Path(__file__).resolve().parents[1] / "test-outputs"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"minmax-parse-fail-{route.origin_iata}-{route.destination_iata}-{ts}.txt"
        try:
            out_path.write_text(f"URL: {url}\n\n{body}", encoding="utf-8")
            print(f"[debug] wrote parse-fail body to {out_path}")
        except Exception as error:
            print(f"[warn] failed to write parse-fail body: {error}")

    @staticmethod
    def _default_depart_date() -> str:
        return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 30 * 86400))

    @staticmethod
    def _add_days_utc(iso_date: str, days: int) -> str:
        try:
            t = time.strptime(iso_date, "%Y-%m-%d")
            epoch = int(time.mktime(t)) + (days * 86400)
            return time.strftime("%Y-%m-%d", time.gmtime(epoch))
        except Exception:
            return MinMaxValidator._default_depart_date()

    @staticmethod
    def _to_int(value: Any) -> Optional[int]:
        if value is None:
            return None
        try:
            return int(float(value))
        except Exception:
            return None

    @staticmethod
    def _to_float(value: Any) -> Optional[float]:
        if value is None:
            return None
        try:
            return float(value)
        except Exception:
            return None

    @staticmethod
    def _to_iso_date(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        t = value.strip()
        return t if ISO_DATE_RE.match(t) else None


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Google Flights min/max and update Supabase results.")
    parser.add_argument("--limit", type=int, default=50, help="Max number of routes to process (default: 50).")
    parser.add_argument("--timeout", type=int, default=35, help="Seconds to wait for FlightsFrontendUi capture.")
    parser.add_argument("--headless", action="store_true", help="Run Chrome headless.")
    parser.add_argument("--dry-run", action="store_true", help="Do not write DB updates.")
    parser.add_argument("--origin", type=str, default="", help="Optional origin IATA filter.")
    parser.add_argument("--destination", type=str, default="", help="Optional destination IATA filter.")
    parser.add_argument(
        "--baseline-existing-minmax-only",
        action="store_true",
        help="Only process rows already having min_price and max_price non-null.",
    )
    parser.add_argument("--retries", type=int, default=2, help="Navigation/capture retries per route.")
    parser.add_argument("--dump-body-on-fail", action="store_true", help="Write intercepted body when parsing fails.")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    project_root = Path(__file__).resolve().parents[1]
    load_dotenv(project_root / ".env")
    args = parse_args(argv)

    validator = MinMaxValidator(
        headless=args.headless,
        limit=max(1, int(args.limit)),
        timeout=max(5, int(args.timeout)),
        dry_run=bool(args.dry_run),
        origin_filter=args.origin.strip() or None,
        destination_filter=args.destination.strip() or None,
        baseline_requires_existing_minmax=bool(args.baseline_existing_minmax_only),
        retries_per_route=max(1, int(args.retries)),
        dump_body_on_fail=bool(args.dump_body_on_fail),
    )
    try:
        validator.run()
        return 0
    finally:
        validator.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
