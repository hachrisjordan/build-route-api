#!/usr/bin/env python3
"""
Fetch Google Flights HTML (no browser, no dates) and parse embedded init-data
for USD price band min/max, then update google_flights_explore_destination_prices.

URL shape (example one-way):
  https://www.google.com/travel/flights?q=Flights%20to%20YTZ%20from%20CGK%20business%20class%20one%20way&curr=USD

Round-trip uses "round trip" instead of "one way" in the q= phrase.

Min/max: extracted from embedded JSON like [[1,[null,…],[null,…],[null,…],[null,3000],[null,3850],3,…
(last two [null,N] before ",3," are the band in USD for the example snapshot).

percentage: 0 inside [min,max]; negative when db price is below min (magnitude = % under min);
positive when above max (magnitude = % over max).

Fetches run in parallel (default 10 threads); each worker uses its own HTTP session.
Per-route retries use exponential backoff on network errors or missing min/max band.
Main thread applies Supabase updates and prints lines (including percentage on success).
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote_plus

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

# Embedded JSON.parse('\\x5b\\x5b1,\\x5bnull,2510\\x5d,...\\x5bnull,3000\\x5d,\\x5bnull,3850\\x5d,3,')
# Variants observed:
# - Leading index is numeric and can vary (1,2,3,4,...)
# - Early values can be negative (e.g. [3,[null,2200],[null,2100],[null,-101],[null,1750],[null,2750],3,...])
META_BAND_HEX_ESCAPED = re.compile(
    r"\\x5b(?:\\x5b)?\d+,\\x5bnull,(-?\d+)\\x5d,\\x5bnull,(-?\d+)\\x5d,\\x5bnull,(-?\d+)\\x5d,"
    r"\\x5bnull,(-?\d+)\\x5d,\\x5bnull,(-?\d+)\\x5d,3,"
)
# Same structure with normal brackets (AF_initDataCallback data: ...).
# Accepts [[n,... and [n,... variants where n is numeric.
META_BAND_PLAIN = re.compile(
    r"\[(?:\[)?\d+,\s*\[null,\s*(-?\d+)\],\s*\[null,\s*(-?\d+)\],\s*\[null,\s*(-?\d+)\],\s*"
    r"\[null,\s*(-?\d+)\],\s*\[null,\s*(-?\d+)\],\s*3,",
)
# Variant where the 3rd slot can be [] instead of [null,<n>], observed in DEN-BOG snapshots.
META_BAND_PLAIN_EMPTY_THIRD = re.compile(
    r"\[(?:\[)?\d+,\s*\[null,\s*-?\d+\],\s*\[null,\s*-?\d+\],\s*\[\],\s*"
    r"\[null,\s*(-?\d+)\],\s*\[null,\s*(-?\d+)\],\s*3,",
)

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

def backoff_seconds(attempt_index: int, *, base_sec: float, max_sec: float) -> float:
    """attempt_index 0 = first retry wait; doubles each time, capped."""
    if attempt_index < 0:
        return 0.0
    return min(max_sec, base_sec * (2**attempt_index))


def _create_supabase() -> Client:
    import os

    url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
        )
    return create_client(url, key)


@dataclass
class RouteRow:
    id: str
    origin_iata: str
    destination_iata: str
    roundtrip: str
    price: Optional[int]
    cpm: Optional[float]
    min_price: Optional[int]
    max_price: Optional[int]


def _to_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_airport_region_map(sb: Client) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    page_size = 2000
    from_idx = 0
    while True:
        res = sb.table("airports").select("iata,region").range(from_idx, from_idx + page_size - 1).execute()
        rows = res.data or []
        if not rows:
            break
        for row in rows:
            iata = str(row.get("iata") or "").strip().upper()
            if iata:
                mapping[iata] = str(row.get("region") or "").strip()
        if len(rows) < page_size:
            break
        from_idx += page_size
    return mapping


def fetch_candidates(
    sb: Client,
    *,
    limit: int,
    origin_filter: Optional[str],
    destination_filter: Optional[str],
    override_existing_minmax: bool,
    airport_regions: Dict[str, str],
) -> List[RouteRow]:
    out: List[RouteRow] = []
    effective_limit = limit if limit > 0 else 1_000_000_000
    page_size = 1000
    from_idx = 0
    o_f = origin_filter.upper() if origin_filter else None
    d_f = destination_filter.upper() if destination_filter else None

    while len(out) < effective_limit:
        res = (
            sb.table("google_flights_explore_destination_prices")
            .select("id,origin_iata,destination_iata,roundtrip,price,cpm,min_price,max_price")
            .order("cpm", desc=False)
            .range(from_idx, from_idx + page_size - 1)
            .execute()
        )
        rows = res.data or []
        if not rows:
            break
        for row in rows:
            origin = str(row.get("origin_iata") or "").strip().upper()
            dest = str(row.get("destination_iata") or "").strip().upper()
            if not origin or not dest:
                continue
            if o_f and origin != o_f:
                continue
            if d_f and dest != d_f:
                continue
            region = airport_regions.get(dest)
            if not region or region.lower() == "unknown":
                continue
            mn = _to_int(row.get("min_price"))
            mx = _to_int(row.get("max_price"))
            # Default behavior: skip routes already processed with both min/max set.
            if not override_existing_minmax and (mn is not None and mx is not None):
                continue
            out.append(
                RouteRow(
                    id=str(row["id"]),
                    origin_iata=origin,
                    destination_iata=dest,
                    roundtrip=str(row.get("roundtrip") or "oneway").strip().lower(),
                    price=_to_int(row.get("price")),
                    cpm=_to_float(row.get("cpm")),
                    min_price=mn,
                    max_price=mx,
                )
            )
            if len(out) >= effective_limit:
                break
        if len(rows) < page_size:
            break
        from_idx += page_size
    return out


def build_search_url(origin: str, dest: str, roundtrip: str) -> str:
    origin = origin.strip().upper()
    dest = dest.strip().upper()
    if roundtrip.strip().lower() == "roundtrip":
        trip = "round trip"
    else:
        trip = "one way"
    # Match requested format: "flights from SEA to EZE business class one way"
    q = f"flights from {origin} to {dest} business class {trip}"
    return f"https://www.google.com/travel/flights?q={quote_plus(q)}&curr=USD"


def extract_price_band_usd(html: str) -> Optional[Tuple[int, int]]:
    for pattern in (META_BAND_HEX_ESCAPED, META_BAND_PLAIN):
        m = pattern.search(html)
        if not m:
            continue
        low, high = int(m.group(4)), int(m.group(5))
        if low > high:
            low, high = high, low
        if 100 <= low <= 200_000 and 100 <= high <= 200_000:
            return low, high
    # Fallback for datasets where the third bucket is an empty array: [..., [], [null,min], [null,max], 3, ...]
    m2 = META_BAND_PLAIN_EMPTY_THIRD.search(html)
    if m2:
        low, high = int(m2.group(1)), int(m2.group(2))
        if low > high:
            low, high = high, low
        if 100 <= low <= 200_000 and 100 <= high <= 200_000:
            return low, high
    return None


def compute_percentage(db_price: int, min_price: int, max_price: int) -> float:
    if db_price < min_price:
        return -((min_price - db_price) / float(min_price)) * 100.0
    if db_price > max_price:
        return ((db_price - max_price) / float(max_price)) * 100.0
    return 0.0


def fetch_html(url: str, *, timeout: int, session: requests.Session) -> str:
    headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    r = session.get(url, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r.text


def fetch_band_with_retries(
    url: str,
    *,
    local_html_path: str,
    timeout: int,
    session: requests.Session,
    max_attempts: int,
    backoff_base_sec: float,
    backoff_max_sec: float,
    sleep_after_success_ms: int,
) -> Tuple[Optional[Tuple[int, int]], Optional[str], int]:
    """
    Returns (band, None, attempts_used) on success, or (None, last_error_message, attempts_used).
    Retries on HTTP errors and on HTML that does not contain a parseable band.
    """
    attempts_budget = 1 if local_html_path else max(1, max_attempts)
    last_err: Optional[str] = None
    for attempt in range(attempts_budget):
        if attempt > 0:
            delay = backoff_seconds(
                attempt - 1, base_sec=backoff_base_sec, max_sec=backoff_max_sec
            )
            time.sleep(delay)

        try:
            if local_html_path:
                html = Path(local_html_path).read_text(encoding="utf-8", errors="replace")
            else:
                html = fetch_html(url, timeout=timeout, session=session)
        except requests.RequestException as e:
            last_err = f"fetch: {e}"
            continue

        band = extract_price_band_usd(html)
        if band:
            if sleep_after_success_ms > 0 and not local_html_path:
                time.sleep(sleep_after_success_ms / 1000.0)
            return band, None, attempt + 1

        last_err = "parse: no USD min/max band in HTML"

    return None, last_err, attempts_budget


@dataclass(frozen=True)
class FetchOutcome:
    row: RouteRow
    url: str
    band: Optional[Tuple[int, int]]
    error: Optional[str]
    attempts: int


def _fetch_one_route(
    row: RouteRow,
    *,
    local_html_path: str,
    timeout: int,
    max_attempts: int,
    backoff_base_sec: float,
    backoff_max_sec: float,
    sleep_after_success_ms: int,
) -> FetchOutcome:
    url = build_search_url(row.origin_iata, row.destination_iata, row.roundtrip)
    session = requests.Session()
    band, err, n = fetch_band_with_retries(
        url,
        local_html_path=local_html_path,
        timeout=timeout,
        session=session,
        max_attempts=max_attempts,
        backoff_base_sec=backoff_base_sec,
        backoff_max_sec=backoff_max_sec,
        sleep_after_success_ms=sleep_after_success_ms,
    )
    return FetchOutcome(row=row, url=url, band=band, error=err, attempts=n)


def main(argv: Sequence[str]) -> int:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser(
        description="Fetch Google Flights HTML and parse USD min/max band; update Supabase."
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max rows to process. Default 0 = no limit (process all eligible rows).",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--origin", default="")
    parser.add_argument("--destination", default="")
    parser.add_argument(
        "--override",
        action="store_true",
        help="Include rows that already have min_price and max_price set.",
    )
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=800,
        help="Pause after each successful HTTP response per worker (not backoff). Often set 0 with --workers>1.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=50,
        help="Parallel fetch threads (each uses its own requests.Session).",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=4,
        help="Per-route attempts for fetch+parse (1 = no retry). Uses exponential backoff between attempts.",
    )
    parser.add_argument(
        "--backoff-base-sec",
        type=float,
        default=1.0,
        help="First retry waits this many seconds (then 2x, 4x, capped by --backoff-max-sec).",
    )
    parser.add_argument(
        "--backoff-max-sec",
        type=float,
        default=60.0,
        help="Cap on exponential backoff delay between attempts.",
    )
    parser.add_argument(
        "--local-html",
        default="",
        help="If set, read this file instead of HTTP (for debugging); still uses --origin/--dest for logging unless paired with --limit 0 trick: use --from-local only",
    )
    parser.add_argument(
        "--test-parse-file",
        default="",
        help="Print extracted min/max from this HTML file and exit.",
    )
    args = parser.parse_args(list(argv))

    if args.test_parse_file:
        text = Path(args.test_parse_file).read_text(encoding="utf-8", errors="replace")
        band = extract_price_band_usd(text)
        print(f"extract_price_band_usd: {band}")
        return 0

    sb = _create_supabase()
    regions = load_airport_region_map(sb)
    candidates = fetch_candidates(
        sb,
        limit=args.limit,
        origin_filter=args.origin.strip() or None,
        destination_filter=args.destination.strip() or None,
        override_existing_minmax=args.override,
        airport_regions=regions,
    )

    workers = max(1, args.workers)
    processed = updated = failed = 0
    local_html = args.local_html.strip()
    fetch_kw = dict(
        local_html_path=local_html,
        timeout=args.timeout,
        max_attempts=args.max_attempts,
        backoff_base_sec=args.backoff_base_sec,
        backoff_max_sec=args.backoff_max_sec,
        sleep_after_success_ms=max(0, args.sleep_ms),
    )

    print(f"[parallel] workers={workers} jobs={len(candidates)}")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(_fetch_one_route, row, **fetch_kw): row for row in candidates}
        for fut in as_completed(future_map):
            processed += 1
            outcome = fut.result()
            row = outcome.row
            if not outcome.band:
                failed += 1
                print(
                    f"[warn] {row.origin_iata}-{row.destination_iata} "
                    f"after {outcome.attempts} attempt(s): {outcome.error} url={outcome.url!r}"
                )
                continue

            min_p, max_p = outcome.band
            if row.price is None or row.price <= 0:
                print(
                    f"[skip] no db price {row.origin_iata}-{row.destination_iata} "
                    f"min={min_p} max={max_p}"
                )
                continue

            pct = compute_percentage(row.price, min_p, max_p)
            pct_r = round(pct, 4)
            patch = {
                "min_price": min_p,
                "max_price": max_p,
                "percentage": pct_r,
            }
            if args.dry_run:
                print(
                    f"[DRY-RUN] id={row.id} {row.origin_iata}-{row.destination_iata} "
                    f"type={row.roundtrip} db_price={row.price} min={min_p} max={max_p} "
                    f"pct={pct_r}"
                )
            else:
                sb.table("google_flights_explore_destination_prices").update(patch).eq("id", row.id).execute()
                print(
                    f"[ok] id={row.id} {row.origin_iata}-{row.destination_iata} "
                    f"type={row.roundtrip} db_price={row.price} min={min_p} max={max_p} pct={pct_r}"
                )
            updated += 1

    print(f"[summary] processed={processed} updated_or_logged={updated} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        raise SystemExit(130)
