"""
Google Flights Explore — uses Playwright to intercept GetExploreDestinations.

Usage:
    python gflights_explore.py HAN Europe business 2026-07 --trip 1week
    python gflights_explore.py JFK "South America" economy 2026-06
    python gflights_explore.py LAX Asia first 2026-08 --trip 2weeks
    python gflights_explore.py HAN Africa business --one-way
    python gflights_explore.py NYC,TYO business --export out.json --quiet
    python gflights_explore.py HAN Europe economy --supabase
    With --supabase, destination-price upserts and missing-airport/airline staging run after each origin (partial progress if a later origin fails).
"""

import json
import os
import sys
import re
import csv
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from typing import Any, Iterable

from playwright.sync_api import sync_playwright
from playwright.sync_api import Error as PlaywrightError

# Strict 3-letter airport codes only (no metro e.g. NYC/TYO) for Supabase upsert.
IATA_RE = re.compile(r"^[A-Z]{3}$")
# Sandbox table from migration (see plan); override with env GOOGLE_FLIGHTS_EXPLORE_OUTPUT_TABLE.
GFLIGHTS_DEFAULT_EXPLORE_OUTPUT_TABLE = "google_flights_explore_destination_prices_copy"
GFLIGHTS_DEFAULT_PAIRING_STATUS_TABLE = "google_flights_explore_pairing_status_copy"

# Continent names for Explore URLs / fanout. Pacific uses Google’s label ``Australia`` in the URL.
# Supabase ``airports.region`` stores it as ``Oceania`` — we map between them for home-region exclusion.
_EXPLORE_FANOUT_CONTINENTS: tuple[str, ...] = (
    "Africa",
    "Asia",
    "Europe",
    "North America",
    "Australia",
    "South America",
)


def _canonical_explore_macro_region(label: str) -> str:
    """
    Canonical bucket for the Pacific macro-region so we can match Supabase ``airports.region``.
    Supabase uses ``Oceania``; Google sometimes uses ``Australia`` for the same macro-region.
    """
    s = (label or "").strip()
    if not s:
        return s
    if s.lower() in ("australia", "oceania"):
        return "Oceania"
    return s


def _explore_region_display_label(label: str) -> str:
    """Stored fields and Explore URLs use Google’s ``Australia`` label for the Pacific region."""
    c = _canonical_explore_macro_region(label)
    if not c:
        return ""
    if c == "Oceania":
        return "Australia"
    return c


def explore_fanout_regions_for_origin(
    origin_iata: str,
    *,
    quiet: bool = False,
) -> list[str]:
    """
    Continents to search for ``origin_iata``, excluding its home ``airports.region`` in Supabase
    (same rule as ogfiles: do not Explore to your own continent). If lookup fails, returns all six.
    """
    code = origin_iata.strip().upper()
    try:
        from ogfiles import fetch_airport_region_from_supabase

        home = fetch_airport_region_from_supabase(code)
        home_c = _canonical_explore_macro_region(home)
        out = [
            r
            for r in _EXPLORE_FANOUT_CONTINENTS
            if _canonical_explore_macro_region(r) != home_c
        ]
        if len(out) < len(_EXPLORE_FANOUT_CONTINENTS) and not quiet:
            print(
                f"[info] Origin {code} is in {home!r}; excluding that continent from regional fanout.",
                file=sys.stderr,
            )
        return out
    except Exception as exc:
        if not quiet:
            print(
                f"[info] Could not infer home region for {code} ({type(exc).__name__}: {exc}); "
                f"using all {len(_EXPLORE_FANOUT_CONTINENTS)} continents.",
                file=sys.stderr,
            )
        return list(_EXPLORE_FANOUT_CONTINENTS)


def write_gflights_pairing_statuses(
    run_id: uuid.UUID,
    origin_iata: str,
    pairing_events: list[tuple[str, str, int]],
    cycle_duration_seconds: float | None,
    *,
    pairing_table: str | None = None,
    debug: bool = False,
) -> None:
    """
    One row per (origin, destination_region, trip_type): success if api_count > 0, else failed.
    ``cycle_duration_seconds`` is the full wall time for that origin’s explore cycle (stored on every row).
    Mirrors ogfiles upsert_explore_pairing_status for Playwright captures.
    """
    if not pairing_events:
        return
    from ogfiles import load_env_into_os_environ, upsert_explore_pairing_status

    load_env_into_os_environ()
    tbl = (pairing_table or "").strip() or os.environ.get(
        "GOOGLE_FLIGHTS_EXPLORE_PAIRING_STATUS_TABLE", GFLIGHTS_DEFAULT_PAIRING_STATUS_TABLE
    )
    def _is_transient_supabase_502(exc: Exception) -> bool:
        # Supabase is behind Cloudflare; 502 responses can come back as HTML instead of JSON,
        # which breaks the postgrest client's JSON parsing.
        s = str(exc)
        return (
            "502" in s
            and ("Bad gateway" in s or "cloudflare" in s.lower() or "JSON could not be generated" in s)
        )

    queued_failures: list[tuple[str, str, str, str | None]] = []
    for dest_region, trip_type, api_n in pairing_events:
        status = "success" if api_n > 0 else "failed"
        err: str | None = None if status == "success" else "No GetExploreDestinations response captured"
        try:
            upsert_explore_pairing_status(
                run_id,
                origin_iata,
                dest_region,
                trip_type,
                status,
                pairing_table=tbl,
                error_message=err,
                cycle_duration_seconds=cycle_duration_seconds,
                debug=debug,
            )
        except Exception as exc:
            if _is_transient_supabase_502(exc):
                queued_failures.append((dest_region, trip_type, status, err))
                if debug:
                    print(
                        f"[warn] pairing upsert transient failure queued "
                        f"(origin={origin_iata}, dest={dest_region}, trip={trip_type}, status={status}): "
                        f"{type(exc).__name__}: {exc}",
                        file=sys.stderr,
                    )
                continue
            raise

    # Retry queued pairing writes after the capture pass finishes, so a transient 502
    # doesn't kill the whole origin.
    if queued_failures:
        attempts = 3
        delay_seconds = 1.0
        for dest_region, trip_type, status, err in queued_failures:
            last_exc: Exception | None = None
            for att in range(attempts):
                try:
                    upsert_explore_pairing_status(
                        run_id,
                        origin_iata,
                        dest_region,
                        trip_type,
                        status,
                        pairing_table=tbl,
                        error_message=err,
                        cycle_duration_seconds=cycle_duration_seconds,
                        debug=debug,
                    )
                    last_exc = None
                    break
                except Exception as exc:
                    last_exc = exc
                    if debug:
                        print(
                            f"[warn] pairing upsert retry {att + 1}/{attempts} failed "
                            f"(origin={origin_iata}, dest={dest_region}, trip={trip_type}): "
                            f"{type(exc).__name__}: {exc}",
                            file=sys.stderr,
                        )
                    time.sleep(delay_seconds)
            if last_exc is not None and debug:
                print(
                    f"[warn] pairing upsert retry exhausted "
                    f"(origin={origin_iata}, dest={dest_region}, trip={trip_type}): "
                    f"{type(last_exc).__name__}: {last_exc}",
                    file=sys.stderr,
                )


def _parse_dates_for_db(dates: str | None, *, one_way: bool) -> tuple[str | None, str | None]:
    """Map explore `dates` string to departDate / arriveDate (YYYY-MM-DD)."""
    if not dates:
        return None, None
    s = str(dates).strip()
    if " to " in s:
        a, b = s.split(" to ", 1)
        da = a.strip()[:10] if len(a.strip()) >= 10 else None
        ar = b.strip()[:10] if len(b.strip()) >= 10 else None
        return da, ar
    dep = s[:10] if len(s) >= 10 else None
    return dep, None if one_way else dep


def _airline_codes_from_gflights_row(
    row: dict[str, Any],
    *,
    google_name_to_code: dict[str, str],
) -> list[str]:
    from ogfiles import _normalize_google_airline_name, _split_multi_airline_names

    token = (row.get("airline") or "").strip()
    name_raw = (row.get("airline_name") or "").strip()
    if token.lower() == "multi":
        out: list[str] = []
        for part in _split_multi_airline_names(name_raw):
            code = google_name_to_code.get(_normalize_google_airline_name(part))
            if code and re.fullmatch(r"[A-Z0-9]{2,3}", code.upper()):
                out.append(code.upper())
        return sorted(set(out))
    if not token or token.lower() == "multi":
        return []
    cu = token.upper()
    if re.fullmatch(r"[A-Z0-9]{2,3}", cu):
        return [cu]
    return []


def _airline_google_pairs_from_gflights_rows(
    rows: list[dict[str, Any]],
    google_name_to_code: dict[str, str],
) -> dict[str, str]:
    """
    Airline code -> display name for `sync_airline_google_pairs`: non-multi rows plus
    multi-carrier rows resolved via `google_name_to_code` (same names as `_airline_codes_from_gflights_row`).
    """
    from ogfiles import _normalize_google_airline_name, _split_multi_airline_names

    pairs: dict[str, str] = {}
    for row in rows:
        token = (row.get("airline") or "").strip()
        name_raw = (row.get("airline_name") or "").strip()
        if not token:
            continue
        if token.lower() == "multi":
            if not name_raw:
                continue
            for part in _split_multi_airline_names(name_raw):
                code = google_name_to_code.get(_normalize_google_airline_name(part))
                if not code:
                    continue
                cu = code.strip().upper()
                if not re.fullmatch(r"[A-Z0-9]{2,3}", cu):
                    continue
                part_clean = part.strip()
                if cu not in pairs:
                    pairs[cu] = part_clean
            continue
        cu = token.upper()
        if not re.fullmatch(r"[A-Z0-9]{2,3}", cu):
            continue
        if name_raw:
            pairs[cu] = name_raw
    return pairs


def _cpm_usd(
    price: int,
    origin_iata: str,
    dest_iata: str,
    roundtrip_token: str,
    latlon_by_iata: dict[str, tuple[float, float]],
) -> float | None:
    from ogfiles import haversine_miles

    o = latlon_by_iata.get(origin_iata)
    d = latlon_by_iata.get(dest_iata)
    if not o or not d:
        return None
    miles = haversine_miles(o[0], o[1], d[0], d[1])
    if miles <= 0:
        return None
    mult = 2.0 if roundtrip_token == "roundtrip" else 1.0
    return (float(price) / (miles * mult)) * 100.0


def gflights_rows_to_supabase_records(
    rows: list[dict[str, Any]],
    *,
    latlon_by_iata: dict[str, tuple[float, float]],
    google_name_to_code: dict[str, str],
) -> list[dict[str, Any]]:
    """Build Supabase row dicts (same shape as ogfiles parse_explore_csv_row_for_supabase)."""
    out: list[dict[str, Any]] = []
    for row in rows:
        o = (row.get("origin") or "").strip().upper()
        d = (row.get("airport") or "").strip().upper()
        if not IATA_RE.match(o) or not IATA_RE.match(d):
            continue
        ow = bool(row.get("one_way"))
        rt = "oneway" if ow else "roundtrip"
        price = row.get("price")
        if price is None:
            continue
        try:
            price_i = int(price)
        except (TypeError, ValueError):
            continue
        dep, arr = _parse_dates_for_db(row.get("dates"), one_way=ow)
        airlines = _airline_codes_from_gflights_row(row, google_name_to_code=google_name_to_code)
        explore_region = row.get("explore_region")
        er = str(explore_region).strip() if explore_region else None
        rec: dict[str, Any] = {
            "origin_iata": o,
            "destination_iata": d,
            "roundtrip": rt,
            "j": "j",
            "price": price_i,
        }
        if er:
            rec["explore_region"] = er
        if dep:
            rec["departDate"] = dep
        if arr:
            rec["arriveDate"] = arr
        elif ow:
            rec["arriveDate"] = None
        if airlines:
            rec["airlines"] = airlines
        cpm = _cpm_usd(price_i, o, d, rt, latlon_by_iata)
        if cpm is not None:
            rec["cpm"] = cpm
        out.append(rec)
    return out


def push_gflights_results_to_supabase(
    rows: list[dict[str, Any]],
    *,
    output_table: str | None = None,
    debug: bool = False,
) -> bool:
    """
    Pre-fetch airports lat/lon + airline maps, upsert + alerts (ogfiles upsert_explore_destination_records),
    then record destination IATAs / airline codes that are missing from canonical ``airports`` / ``airlines``
    into staging tables (``gflights_explore_missing_airports`` / ``gflights_explore_missing_airlines``).
    """
    from ogfiles import (
        ensure_missing_airlines_for_gflights_explore_pairs,
        ensure_missing_airports_for_gflights_explore_rows,
        fetch_airline_code_maps_for_explore,
        fetch_airports_latlon_by_iata,
        load_env_into_os_environ,
        upsert_explore_destination_records,
    )

    load_env_into_os_environ()
    if not rows:
        return True
    iatas: set[str] = set()
    for row in rows:
        o = (row.get("origin") or "").strip().upper()
        d = (row.get("airport") or "").strip().upper()
        if IATA_RE.match(o):
            iatas.add(o)
        if IATA_RE.match(d):
            iatas.add(d)
    latlon = fetch_airports_latlon_by_iata(
        iatas,
        execute_max_attempts=3,
        execute_retry_delay=1.0,
        debug=debug,
    )
    _, google_map = fetch_airline_code_maps_for_explore(
        execute_max_attempts=3,
        execute_retry_delay=1.0,
        debug=debug,
    )
    pairs = _airline_google_pairs_from_gflights_rows(rows, google_map)
    ensure_missing_airlines_for_gflights_explore_pairs(
        pairs,
        execute_max_attempts=3,
        execute_retry_delay=1.0,
        debug=debug,
    )
    records = gflights_rows_to_supabase_records(
        rows,
        latlon_by_iata=latlon,
        google_name_to_code=google_map,
    )
    if not records:
        if debug:
            print("[supabase] No rows mapped to records (check IATA codes).", file=sys.stderr)
    else:
        tbl = (output_table or "").strip() or os.environ.get(
            "GOOGLE_FLIGHTS_EXPLORE_OUTPUT_TABLE", GFLIGHTS_DEFAULT_EXPLORE_OUTPUT_TABLE
        )
        try:
            upsert_explore_destination_records(records, output_table=tbl, debug=debug)
        except Exception as exc:
            print(f"[supabase] Upsert failed: {exc}", file=sys.stderr)
            return False

    ensure_missing_airports_for_gflights_explore_rows(
        rows,
        execute_max_attempts=3,
        execute_retry_delay=1.0,
        debug=debug,
    )
    return True


def build_explore_url(
    origin: str,
    destination_region: str,
    cabin: str = "economy",
    month: str = "",
    trip_length: str = "1week",
    currency: str = "USD",
    one_way: bool = False,
) -> str:
    cabin_map = {
        "economy": "",
        "premium_economy": "premium+economy",
        "business": "business+class",
        "first": "first+class",
    }
    trip_map = {
        "weekend": "weekend+trip",
        "1week": "1+week+trip",
        "2weeks": "2+week+trip",
    }

    if one_way:
        parts = [f"one+way+flights+from+{origin}"]
    else:
        parts = [f"flights+from+{origin}"]
    if destination_region:
        dest = _explore_region_display_label(destination_region)
        parts.append(f"to+{dest.replace(' ', '+')}")
    if cabin in cabin_map and cabin_map[cabin]:
        parts.append(cabin_map[cabin])
    if one_way:
        if month:
            parts.append(f"in+{month.replace(' ', '+')}")
        else:
            parts.append("next+6+months")
    else:
        if trip_length in trip_map:
            parts.append(trip_map[trip_length])
        if month:
            parts.append(f"in+{month.replace(' ', '+')}")

    q = "+".join(parts)
    return f"https://www.google.com/travel/explore?q={q}&curr={currency}"


def explore(
    origin: str,
    destination_region: str = "",
    cabin: str = "economy",
    month: str = "",
    trip_length: str = "1week",
    currency: str = "USD",
    one_way: bool = False,
    headless: bool = True,
    quiet: bool = False,
) -> tuple[list[dict], list[str]]:
    """
    Search Google Flights Explore and return destination prices.
    Uses Playwright to intercept the GetExploreDestinations API response.
    """
    url = build_explore_url(
        origin,
        destination_region,
        cabin,
        month,
        trip_length,
        currency,
        one_way=one_way,
    )
    if not quiet:
        print(f"URL: {url}")

    results = []
    captured_responses = []
    expected_origin = origin.strip().upper()
    # Google Explore payloads sometimes embed IATA codes as plain JSON string literals (`"IAH"`)
    # and sometimes with escaped quotes (`\"IAH\"`). Accept both to avoid dropping valid captures.
    origin_token_quoted = f'"{expected_origin}"'
    origin_token_escaped = f'\\"{expected_origin}\\"'

    def handle_response(response):
        if "GetExploreDestinations" in response.url:
            try:
                body = response.text()
                # Only keep responses that correspond to the requested origin.
                # (Occasionally other background Explore requests can hit the same route.)
                quoted_cnt = body.count(origin_token_quoted)
                escaped_cnt = body.count(origin_token_escaped)
                match_cnt = quoted_cnt + escaped_cnt
                # If we match 2+ times, treat it as ambiguous and reject (prevents capturing payloads
                # that contain multiple explore cycles / origins in one response dump).
                if match_cnt != 1:
                    if not quiet:
                        print(
                            f"Skipping captured body: origin {expected_origin!r} match count {match_cnt} "
                            f"(quoted={quoted_cnt}, escaped={escaped_cnt}).",
                            file=sys.stderr,
                        )
                    return
                captured_responses.append(body)
            except Exception:
                pass

    # Keep launch flags conservative on macOS. Some Linux/container flags can crash Chromium.
    chromium_args = ["--disable-gpu"]
    if sys.platform.startswith("linux"):
        chromium_args.extend([
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--no-zygote",
        ])

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, args=chromium_args)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        page.on("response", handle_response)

        def _try_click_visible_button_by_text(target_page, labels: list[str]) -> bool:
            for label in labels:
                loc = target_page.locator(f"button:has-text('{label}')").first
                try:
                    if loc.is_visible(timeout=500):
                        loc.click(timeout=2000)
                        return True
                except Exception:
                    pass
            return False

        def _clear_google_consent_gate_if_present() -> None:
            try:
                cur = (page.url or "").lower()
            except Exception:
                cur = ""
            if "consent.google." not in cur:
                return
            if not quiet:
                print("[info] Google consent interstitial detected; attempting auto-accept.", file=sys.stderr)
            accept_labels = [
                "Accept all",
                "I agree",
                "Accept",
                "Đồng ý",
                "Chấp nhận tất cả",
            ]
            for _ in range(8):
                if _try_click_visible_button_by_text(page, accept_labels):
                    page.wait_for_timeout(800)
                try:
                    cur = (page.url or "").lower()
                except Exception:
                    cur = ""
                if "consent.google." not in cur:
                    break

        def _accept_cookie_banner_if_present() -> None:
            accept_labels = [
                "Accept all",
                "Accept",
                "I agree",
                "Got it",
                "Chấp nhận tất cả",
                "Đồng ý",
            ]
            if _try_click_visible_button_by_text(page, accept_labels):
                page.wait_for_timeout(500)
                return
            try:
                for fr in page.frames:
                    if fr == page.main_frame:
                        continue
                    if _try_click_visible_button_by_text(fr, accept_labels):
                        page.wait_for_timeout(500)
                        return
            except Exception:
                pass

        try:
            try:
                page.goto(url, wait_until="networkidle", timeout=60000)
            except PlaywrightError as exc:
                # Fallback: retry with a lighter wait strategy if networkidle is unstable.
                message = str(exc)
                if "Target page, context or browser has been closed" not in message:
                    raise
                if not quiet:
                    print("Warning: browser closed during networkidle; retrying with domcontentloaded...")
                if page.is_closed():
                    page = context.new_page()
                    page.on("response", handle_response)
                page.goto(url, wait_until="domcontentloaded", timeout=60000)

            # Align with ogfiles bootstrap behavior: handle consent/cookies at startup if needed.
            _clear_google_consent_gate_if_present()
            _accept_cookie_banner_if_present()
            try:
                if "consent.google." in (page.url or "").lower():
                    page.goto(url, wait_until="domcontentloaded", timeout=60000)
                    _clear_google_consent_gate_if_present()
                    _accept_cookie_banner_if_present()
            except Exception:
                pass

            # Explore page polls for more destinations over 1-3s intervals
            # Wait until no new responses arrive for 5s
            last_count = 0
            stable_ticks = 0
            for _ in range(10):  # max 10s after networkidle
                page.wait_for_timeout(1000)
                if len(captured_responses) == last_count:
                    stable_ticks += 1
                    if stable_ticks >= 3:  # 3s with no new responses = done
                        break
                else:
                    last_count = len(captured_responses)
                    stable_ticks = 0
        finally:
            browser.close()

    if not quiet:
        print(f"Captured {len(captured_responses)} API responses")

    for raw in captured_responses:
        try:
            parsed = _parse_explore_response(raw)
            results.extend(parsed)
        except Exception as e:
            if not quiet:
                print(f"Parse error: {e}")

    for r in results:
        r["origin"] = origin

    return results, captured_responses


def _explore_region(
    spec: tuple[str, bool],
    *,
    origin: str,
    cabin: str,
    month: str,
    trip_length: str,
    currency: str,
    headless: bool,
    quiet: bool,
) -> tuple[str, bool, list[dict], list[str]]:
    """Run explore for one destination region (used for parallel fanout).

    spec is (region_name, one_way).
    """
    sub_region, one_way = spec
    sub_results, sub_raw = explore(
        origin=origin,
        destination_region=sub_region,
        cabin=cabin,
        month=month,
        trip_length=trip_length,
        currency=currency,
        one_way=one_way,
        headless=headless,
        quiet=quiet,
    )
    display_region = _explore_region_display_label(sub_region)
    for row in sub_results:
        row["one_way"] = one_way
        row["explore_region"] = display_region
    return display_region, one_way, sub_results, sub_raw


def _city_block_dates(c: list) -> str:
    """Build dates label from a city block in block 0 (round-trip has start+end; one-way often only c[11])."""
    if len(c) <= 11:
        return ""
    start = c[11]
    end = c[12] if len(c) > 12 else None
    if start and end:
        return f"{start} to {end}"
    if start:
        return str(start)
    if end:
        return str(end)
    return ""


def _parse_explore_response(raw_text: str) -> list[dict]:
    """Parse the GetExploreDestinations response.

    Response format: length-prefixed JSON blocks separated by newlines.
    Block 0: city info (names, coordinates, dates)
    Blocks 1+: flight offers with prices per destination
    """
    cleaned = raw_text.lstrip(")]}'").strip()

    # Parse length-prefixed blocks: "digits\njson\n"
    lines = cleaned.split("\n")
    blocks = []
    i = 0
    while i < len(lines):
        if lines[i].strip().isdigit() and i + 1 < len(lines):
            try:
                blocks.append(json.loads(lines[i + 1]))
            except json.JSONDecodeError:
                pass
        i += 1

    if not blocks:
        return []

    # Block 0: city info — inner JSON at blocks[0][0][2]
    cities = {}
    try:
        inner0 = json.loads(blocks[0][0][2])
        city_list = inner0[3]
        # Unwrap: can be [[[cities...]]] or [[cities...]]
        while isinstance(city_list, list) and len(city_list) == 1 and isinstance(city_list[0], list) and len(city_list[0]) > 0 and isinstance(city_list[0][0], list):
            city_list = city_list[0]
        for c in city_list:
            if isinstance(c, list) and len(c) > 4 and isinstance(c[0], str):
                cities[c[0]] = {
                    "name": c[2],
                    "country": c[4],
                    "dates": _city_block_dates(c),
                }
    except (IndexError, TypeError, json.JSONDecodeError):
        pass

    # Blocks 1+: flight offers — inner JSON at block[0][2], offers at inner[4]
    results = []
    for block in blocks[1:]:
        try:
            if len(block[0]) < 3:
                continue
            inner = json.loads(block[0][2])
        except (IndexError, TypeError, json.JSONDecodeError):
            continue

        if not isinstance(inner, list) or len(inner) < 5:
            continue
        if not isinstance(inner[4], list):
            continue

        # inner[4] is wrapped: [[dest1, dest2, ...]]
        dest_list = inner[4]
        if len(dest_list) == 1 and isinstance(dest_list[0], list) and len(dest_list[0]) > 0 and isinstance(dest_list[0][0], list):
            dest_list = dest_list[0]

        for dest in dest_list:
            if not isinstance(dest, list) or len(dest) < 2:
                continue
            try:
                cid = dest[0]
                if not isinstance(cid, str):
                    continue
                price = dest[1][0][1]

                fi = dest[6] if len(dest) > 6 and isinstance(dest[6], list) else None
                airline = fi[0] if fi else None
                airline_name = fi[1] if fi and len(fi) > 1 else None
                stops = fi[2] if fi and len(fi) > 2 else None
                duration = fi[3] if fi and len(fi) > 3 else None
                airport = fi[5] if fi and len(fi) > 5 else None

                ci = cities.get(cid, {})
                results.append({
                    "city": ci.get("name"),
                    "country": ci.get("country"),
                    "dates": ci.get("dates"),
                    "airport": airport,
                    "price": price,
                    "airline": airline,
                    "airline_name": airline_name,
                    "stops": stops,
                    "duration_min": duration,
                })
            except (IndexError, TypeError):
                continue

    return results


def _json_export_rows(results: list[dict]) -> list[dict]:
    """Stable JSON row shape: origin first, then remaining keys in original order."""
    out: list[dict] = []
    for row in results:
        ordered: dict = {}
        if "origin" in row:
            ordered["origin"] = row["origin"]
        for key, val in row.items():
            if key != "origin":
                ordered[key] = val
        out.append(ordered)
    return out


def _export_results(results: list[dict], export_path: str) -> None:
    path = Path(export_path)
    if path.suffix.lower() == ".json":
        payload = _json_export_rows(results)
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        return

    if path.suffix.lower() == ".csv":
        fieldnames = [
            "origin",
            "city",
            "country",
            "dates",
            "airport",
            "price",
            "airline",
            "airline_name",
            "stops",
            "duration_min",
            "one_way",
        ]
        with path.open("w", newline="", encoding="utf-8") as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
            writer.writeheader()
            for row in results:
                writer.writerow({key: row.get(key) for key in fieldnames})
        return

    raise ValueError("Unsupported export format. Use a .json or .csv file path.")


def _print_region_summary(
    origin: str,
    region: str,
    cabin: str,
    trip_length: str,
    results: Iterable[dict],
    one_way: bool | None = None,
    quiet: bool = False,
) -> None:
    if quiet:
        return

    ow = "one-way, " if one_way else ""
    tl = "next 6 months" if one_way else trip_length
    print(f"\n{origin} \u2192 {region or 'Anywhere'} ({ow}{cabin}, {tl}):\n")

    results_list = list(results)
    if not results_list:
        print("  No results found (response parsing may need adjustment)")
        return

    seen = set()
    for r in sorted(results_list, key=lambda x: x.get("price", 999999)):
        key = r.get("airport") or r.get("city") or str(r)
        if key in seen:
            continue
        seen.add(key)
        price = r.get("price", "?")
        airport = r.get("airport", "")
        city = r.get("city", "")
        airline = r.get("airline", "")
        stops = r.get("stops")
        stop_str = f"({stops} stop{'s' if stops != 1 else ''})" if stops is not None else ""
        label = airport or city
        print(f"  ${price:>6,}  {label:6s}  {airline:4s}  {stop_str}")


def _run_explore_for_single_origin(
    args,
    origin: str,
    *,
    label_prefix: str,
) -> tuple[int, list[dict], list[tuple[str, str, int]]]:
    """Execute one origin's explore flow (inferred global, optional first explore, regional fanout).

    Returns (total_api_response_count, all_rows, pairing_events) where each pairing_events entry is
    (destination_region, trip_type, api_response_count_for_that_segment).
    """
    CABIN_CHOICES = ["economy", "premium_economy", "business", "first"]

    region = args.region
    cabin = args.cabin
    inferred_global_search = False
    if region in CABIN_CHOICES and args.cabin == "economy" and args.month == "":
        if not args.quiet:
            print(
                f"{label_prefix}[info] Treating '{region}' as cabin and running regional searches from {origin}..."
            )
        cabin = region
        region = ""
        inferred_global_search = True

    total_api_responses = 0
    all_results: list[dict] = []
    pairing_events: list[tuple[str, str, int]] = []

    if inferred_global_search:
        fanout_regions = explore_fanout_regions_for_origin(origin, quiet=args.quiet)
        raw_responses: list[str] = []
    else:
        results, raw_responses = explore(
            origin=origin,
            destination_region=region,
            cabin=cabin,
            month=args.month,
            trip_length=args.trip,
            currency=args.currency,
            one_way=args.one_way,
            headless=not args.show_browser,
            quiet=args.quiet,
        )
        total_api_responses += len(raw_responses)
        dr = _explore_region_display_label(region) if region else "Anywhere"
        tt = "oneway" if args.one_way else "roundtrip"
        pairing_events.append((dr, tt, len(raw_responses)))
        for row in results:
            row["one_way"] = args.one_way
            row["explore_region"] = _explore_region_display_label(region) if region else None
        all_results.extend(results)

        if args.raw_response and not args.quiet:
            print(f"\n{label_prefix}Raw GetExploreDestinations responses:\n")
            if not raw_responses:
                print("  (none captured)")
            else:
                for idx, raw in enumerate(raw_responses, 1):
                    print(f"--- response #{idx} ---")
                    print(raw)
                    print()

        fanout_regions = []
        if not results and not region:
            if not args.quiet:
                print(
                    f"{label_prefix}[info] No destinations found for {origin} (anywhere). "
                    "Fanning out to major regions..."
                )
            fanout_regions = explore_fanout_regions_for_origin(origin, quiet=args.quiet)

    if fanout_regions:
        if args.one_way:
            fanout_specs = [(r, True) for r in fanout_regions]
        else:
            fanout_specs = [(r, False) for r in fanout_regions] + [(r, True) for r in fanout_regions]
        n_workers = min(len(fanout_specs), 12)
        if not args.quiet:
            print(
                f"{label_prefix}[info] Running {len(fanout_specs)} regional searches in parallel "
                f"(max_workers={n_workers})..."
            )
        worker = partial(
            _explore_region,
            origin=origin,
            cabin=cabin,
            month=args.month,
            trip_length=args.trip,
            currency=args.currency,
            headless=not args.show_browser,
            quiet=args.quiet,
        )
        with ThreadPoolExecutor(max_workers=n_workers) as executor:
            worker_results = list(executor.map(worker, fanout_specs))

        for sub_region, sub_one_way, sub_results, sub_raw in worker_results:
            total_api_responses += len(sub_raw)
            tt_seg = "oneway" if sub_one_way else "roundtrip"
            pairing_events.append((sub_region, tt_seg, len(sub_raw)))
            all_results.extend(sub_results)
            if not args.quiet:
                mode = "one-way" if sub_one_way else "round-trip"
                print(
                    f"{label_prefix}[info] Found {len(sub_results)} raw rows for region {sub_region} ({mode})"
                )

            if args.raw_response and not args.quiet:
                mode = "one-way" if sub_one_way else "round-trip"
                print(f"\n{label_prefix}Raw GetExploreDestinations responses for {sub_region} ({mode}):\n")
                if not sub_raw:
                    print("  (none captured)")
                else:
                    for idx, raw in enumerate(sub_raw, 1):
                        print(f"--- response #{idx} ({sub_region}, {mode}) ---")
                        print(raw)
                        print()

            _print_region_summary(
                origin=origin,
                region=sub_region,
                cabin=cabin,
                trip_length=args.trip,
                results=sub_results,
                one_way=sub_one_way,
                quiet=args.quiet,
            )
    elif not inferred_global_search:
        _print_region_summary(
            origin=origin,
            region=_explore_region_display_label(region) if region else region,
            cabin=cabin,
            trip_length=args.trip,
            results=results,
            one_way=args.one_way,
            quiet=args.quiet,
        )

    return total_api_responses, all_results, pairing_events


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Google Flights Explore")
    CABIN_CHOICES = ["economy", "premium_economy", "business", "first"]
    parser.add_argument(
        "origin",
        help="Origin airport code(s), comma-separated for multiple (e.g., HAN or NYC,TYO)",
    )
    parser.add_argument(
        "region",
        help="Destination region, or a cabin name with economy+no month to trigger multi-continent fanout "
        "(e.g. HAN business → business cabin, all continents except origin's Supabase region).",
    )
    parser.add_argument("cabin", nargs="?", default="economy", choices=CABIN_CHOICES)
    parser.add_argument("month", nargs="?", default="", help="Month (e.g., 2026-07, July)")
    parser.add_argument("--trip", default="1week", choices=["weekend", "1week", "2weeks"])
    parser.add_argument(
        "--one-way",
        action="store_true",
        help="Use one-way explore URL (e.g. ... one way flights from ORIGIN ... next 6 months)",
    )
    parser.add_argument("--currency", default="USD")
    parser.add_argument("--show-browser", action="store_true", help="Show browser window")
    parser.add_argument(
        "--raw-response",
        action="store_true",
        help="Print captured raw GetExploreDestinations response bodies",
    )
    parser.add_argument(
        "--export",
        default="",
        help="Export parsed results to file (.json or .csv)",
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        help='Print one line per origin: API count, result count, and wall time in seconds (e.g. "... 667 142.3s")',
    )
    parser.add_argument(
        "--supabase",
        action="store_true",
        help="After explore, pre-fetch airports/airlines, upsert to sandbox google_flights_explore_destination_prices_copy, alerts",
    )
    parser.add_argument(
        "--debug-supabase",
        action="store_true",
        help="Verbose Supabase / upsert logs (stderr)",
    )
    parser.add_argument(
        "--supabase-table",
        default="",
        metavar="NAME",
        help="Override output table (default: env GOOGLE_FLIGHTS_EXPLORE_OUTPUT_TABLE or *_copy sandbox)",
    )
    parser.add_argument(
        "--supabase-pairing-table",
        default="",
        metavar="NAME",
        help="Override pairing status table (default: env GOOGLE_FLIGHTS_EXPLORE_PAIRING_STATUS_TABLE or *_copy)",
    )

    args = parser.parse_args()

    origins = [o.strip().upper() for o in args.origin.split(",") if o.strip()]
    if not origins:
        parser.error("At least one origin airport code is required.")

    if args.supabase:
        for o in origins:
            if not IATA_RE.match(o):
                print(
                    f"[error] --supabase requires 3-letter IATA origin codes; {o!r} is invalid (metro codes like NYC/TYO are not supported).",
                    file=sys.stderr,
                )
                sys.exit(2)

    all_results: list[dict] = []
    multi = len(origins) > 1

    run_id: uuid.UUID | None = None
    supabase_output_table: str | None = None
    if args.supabase:
        run_id = uuid.uuid4()
        print(f"explore_run_id={run_id}", file=sys.stderr)
        supabase_output_table = (args.supabase_table or "").strip() or None

    def _run_single_origin_once(
        origin: str,
        *,
        include_in_all_results: bool,
        retry_label: str = "",
    ) -> bool:
        """
        Run one origin once and return True when pairing status indicates a failed segment
        (at least one pairing captured zero API responses).
        """
        label_prefix = f"[{origin}] " if multi else ""
        t0 = time.perf_counter()
        api_n, batch, pairing_events = _run_explore_for_single_origin(
            args, origin, label_prefix=label_prefix
        )
        elapsed_sec = time.perf_counter() - t0
        if include_in_all_results:
            all_results.extend(batch)
        if args.supabase and run_id is not None:
            pt = (args.supabase_pairing_table or "").strip() or None
            write_gflights_pairing_statuses(
                run_id,
                origin,
                pairing_events,
                elapsed_sec,
                pairing_table=pt,
                debug=bool(args.debug_supabase),
            )
            ok_dest = push_gflights_results_to_supabase(
                batch,
                output_table=supabase_output_table,
                debug=bool(args.debug_supabase),
            )
            if not ok_dest:
                print(
                    f"[error] Supabase destination upsert failed for origin {origin}; "
                    "earlier origins may have been written; continuing to next origin.",
                    file=sys.stderr,
                )
            elif not args.quiet:
                print(
                    f"[{origin}] Supabase destination upsert ok ({len(batch)} row(s)).",
                    file=sys.stderr,
                )
        if args.quiet:
            dur = f"{elapsed_sec:.1f}s"
            retry_prefix = f"{retry_label} " if retry_label else ""
            print(
                f"{retry_prefix}[{origin}] API responses captured: {api_n}  Results: {len(batch)}  {dur}"
            )
        return any((count or 0) <= 0 for _, _, count in pairing_events)

    failed_origins: list[str] = []
    for origin in origins:
        has_failed_pairings = _run_single_origin_once(origin, include_in_all_results=True)
        if has_failed_pairings:
            failed_origins.append(origin)

    # Retry failed origins after the initial full pass completes.
    max_end_retries = 3
    pending = list(dict.fromkeys(failed_origins))
    if pending:
        print(
            f"[retry] Initial pass complete. Retrying failed origins at end: {','.join(pending)}",
            file=sys.stderr,
        )
    for attempt in range(1, max_end_retries + 1):
        if not pending:
            break
        next_pending: list[str] = []
        for origin in pending:
            still_failed = _run_single_origin_once(
                origin,
                include_in_all_results=False,
                retry_label=f"[retry {attempt}/{max_end_retries}]",
            )
            if still_failed:
                next_pending.append(origin)
        pending = list(dict.fromkeys(next_pending))
    if pending:
        print(
            f"[warn] Exhausted end retries ({max_end_retries}) for origin(s): {','.join(pending)}",
            file=sys.stderr,
        )

    if args.export:
        try:
            _export_results(all_results, args.export)
            if not args.quiet:
                print(f"\n[info] Exported {len(all_results)} rows to: {args.export}")
        except ValueError as export_error:
            print(f"\n[error] Export error: {export_error}")
