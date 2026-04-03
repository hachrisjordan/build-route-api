#!/usr/bin/env python3
"""
Backfill min_price / max_price on google_flights_explore_destination_prices using the
external gflights.py CLI with --cabin business --range (typical price band in USD).

Environment (same as other Supabase scripts in this repo):
  SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL — project URL
  SUPABASE_SERVICE_ROLE_KEY — service role key (required for updates)

gflights CLI (local install; not bundled here):
  GFLIGHTS_SCRIPT or --gflights-script — path to gflights.py (required)
  GFLIGHTS_PYTHON or --gflights-python — interpreter that has gflights deps (default: python3)

Example:
  export GFLIGHTS_SCRIPT=$HOME/path/to/kells/gflights.py
  # optional: export GFLIGHTS_PYTHON=$HOME/path/to/kells/.venv/bin/python
  python scripts/google-flights-gflights-range.py --dry-run --limit 1
  python scripts/google-flights-gflights-range.py --limit 100 --workers 4

Flags align with google-flights-minmax-html-fetch where applicable: --dry-run, --limit,
--origin, --destination, --override, --workers, --max-attempts, backoff flags, --sleep-ms.

Only min_price and max_price are written; percentage is expected to be filled by the
database trigger on update.

Eligibility matches google-flights-minmax-html-fetch (known destination region, optional
override for existing min/max) plus:
- process `oneway` rows using `departDate`
- process `roundtrip` rows using `departDate` + `arriveDate` (mapped to gflights `--return-date`)

If `departDate` (or `arriveDate` for roundtrip rows) is missing/invalid, the script applies
defaults so the row is still processed.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from dotenv import load_dotenv
from supabase import Client, create_client

TYPICAL_RANGE_RE = re.compile(
    r"Typical range:\s*\$([\d,]+(?:\.\d+)?)\s*[–-]\s*\$([\d,]+(?:\.\d+)?)",
    re.IGNORECASE,
)
UNAVAILABLE_RE = re.compile(r"Typical range:\s*unavailable", re.IGNORECASE)


def backoff_seconds(attempt_index: int, *, base_sec: float, max_sec: float) -> float:
    if attempt_index < 0:
        return 0.0
    return min(max_sec, base_sec * (2**attempt_index))


def _create_supabase() -> Client:
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
    depart_date: str  # YYYY-MM-DD
    return_date: Optional[str]  # YYYY-MM-DD for roundtrip, else None
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


def normalize_depart_date(raw: Any) -> Optional[str]:
    """Return YYYY-MM-DD or None if missing/invalid."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    day = s.split("T", 1)[0].split(" ", 1)[0]
    if len(day) != 10:
        return None
    try:
        date.fromisoformat(day)
        return day
    except ValueError:
        return None


def normalize_trip_type(raw: Any) -> str:
    """Normalize DB `roundtrip` field into 'oneway' | 'roundtrip' (or other string)."""
    s = str(raw or "").strip().lower().replace(" ", "")
    if s == "oneway":
        return "oneway"
    if s == "roundtrip":
        return "roundtrip"
    return s


def load_airport_region_map(sb: Client) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    page_size = 2000
    from_idx = 0
    while True:
        res = (
            sb.table("airports")
            .select("iata,region")
            .range(from_idx, from_idx + page_size - 1)
            .execute()
        )
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


def default_depart_date_str() -> str:
    """YYYY-MM-DD for 30 days after today (local date)."""
    return (date.today() + timedelta(days=30)).isoformat()


def default_return_date_str(depart_date: str, *, default_return_days: int) -> str:
    """Default return date for roundtrip rows with missing/invalid arriveDate."""
    dep = date.fromisoformat(depart_date)
    return (dep + timedelta(days=default_return_days)).isoformat()


def fetch_candidates(
    sb: Client,
    *,
    limit: int,
    origin_filter: Optional[str],
    destination_filter: Optional[str],
    override_existing_minmax: bool,
    airport_regions: Dict[str, str],
    default_return_days: int,
) -> Tuple[List[RouteRow], int, int]:
    out: List[RouteRow] = []
    defaulted_depart = 0
    defaulted_return = 0
    effective_limit = limit if limit > 0 else 1_000_000_000
    page_size = 1000
    from_idx = 0
    o_f = origin_filter.upper() if origin_filter else None
    d_f = destination_filter.upper() if destination_filter else None

    while len(out) < effective_limit:
        res = (
            sb.table("google_flights_explore_destination_prices")
            .select(
                "id,origin_iata,destination_iata,roundtrip,price,cpm,departDate,arriveDate,min_price,max_price"
            )
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
            trip_type = normalize_trip_type(row.get("roundtrip") or "oneway")
            if trip_type not in ("oneway", "roundtrip"):
                continue
            region = airport_regions.get(dest)
            if not region or region.lower() == "unknown":
                continue
            mn = _to_int(row.get("min_price"))
            mx = _to_int(row.get("max_price"))
            if not override_existing_minmax and (mn is not None and mx is not None):
                continue
            dep = normalize_depart_date(row.get("departDate"))
            if not dep:
                dep = default_depart_date_str()
                defaulted_depart += 1
            ret: Optional[str] = None
            if trip_type == "roundtrip":
                ret = normalize_depart_date(row.get("arriveDate"))
                if not ret:
                    ret = default_return_date_str(
                        dep, default_return_days=default_return_days
                    )
                    defaulted_return += 1
            out.append(
                RouteRow(
                    id=str(row["id"]),
                    origin_iata=origin,
                    destination_iata=dest,
                    roundtrip=trip_type,
                    price=_to_int(row.get("price")),
                    cpm=_to_float(row.get("cpm")),
                    depart_date=dep,
                    return_date=ret,
                    min_price=mn,
                    max_price=mx,
                )
            )
            if len(out) >= effective_limit:
                break
        if len(rows) < page_size:
            break
        from_idx += page_size
    return out, defaulted_depart, defaulted_return


def parse_typical_range_usd(text: str) -> Tuple[Optional[Tuple[int, int]], Optional[str]]:
    """Return ((low, high) rounded int USD, None) or (None, error reason)."""
    if UNAVAILABLE_RE.search(text):
        return None, "typical range unavailable"
    m = TYPICAL_RANGE_RE.search(text)
    if not m:
        return None, "no Typical range line in output"
    try:
        lo = round(float(m.group(1).replace(",", "")))
        hi = round(float(m.group(2).replace(",", "")))
    except (TypeError, ValueError) as e:
        return None, f"parse dollars: {e}"
    if lo > hi:
        lo, hi = hi, lo
    return (lo, hi), None


def run_gflights_range(
    row: RouteRow,
    *,
    gflights_python: str,
    gflights_script: str,
    timeout: int,
    max_attempts: int,
    backoff_base_sec: float,
    backoff_max_sec: float,
    sleep_after_success_ms: int,
) -> Tuple[Optional[Tuple[int, int]], Optional[str], int]:
    attempts_budget = max(1, max_attempts)
    if row.roundtrip == "roundtrip" and not row.return_date:
        return None, "missing return_date for roundtrip row", attempts_budget

    cmd: List[str] = [
        gflights_python,
        gflights_script,
        row.origin_iata,
        row.destination_iata,
        row.depart_date,
        "--cabin",
        "business",
        "--range",
    ]
    if row.roundtrip == "roundtrip":
        cmd.extend(["--return-date", row.return_date])  # type: ignore[arg-type]

    last_err: Optional[str] = None
    for attempt in range(attempts_budget):
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            last_err = f"subprocess timeout after {timeout}s"
            if attempt + 1 < attempts_budget:
                time.sleep(backoff_seconds(attempt, base_sec=backoff_base_sec, max_sec=backoff_max_sec))
            continue
        out = (proc.stdout or "") + "\n" + (proc.stderr or "")
        band, err = parse_typical_range_usd(out)
        if band:
            if sleep_after_success_ms > 0:
                time.sleep(sleep_after_success_ms / 1000.0)
            return band, None, attempt + 1
        last_err = err or f"exit={proc.returncode}"
        if attempt + 1 < attempts_budget:
            time.sleep(backoff_seconds(attempt, base_sec=backoff_base_sec, max_sec=backoff_max_sec))
    return None, last_err, attempts_budget


@dataclass(frozen=True)
class RangeOutcome:
    row: RouteRow
    band: Optional[Tuple[int, int]]
    error: Optional[str]
    attempts: int


def _fetch_one_route(
    row: RouteRow,
    *,
    gflights_python: str,
    gflights_script: str,
    timeout: int,
    max_attempts: int,
    backoff_base_sec: float,
    backoff_max_sec: float,
    sleep_after_success_ms: int,
) -> RangeOutcome:
    band, err, n = run_gflights_range(
        row,
        gflights_python=gflights_python,
        gflights_script=gflights_script,
        timeout=timeout,
        max_attempts=max_attempts,
        backoff_base_sec=backoff_base_sec,
        backoff_max_sec=backoff_max_sec,
        sleep_after_success_ms=sleep_after_success_ms,
    )
    return RangeOutcome(row=row, band=band, error=err, attempts=n)


def main(argv: Sequence[str]) -> int:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser(
        description=(
            "Run gflights.py --range (business typical USD band) per eligible row and "
            "update min_price / max_price in Supabase. percentage is left to DB trigger."
        )
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max rows to process. Default 0 = no limit (all eligible rows).",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--origin", default="", help="Only this origin IATA (optional).")
    parser.add_argument("--destination", default="", help="Only this destination IATA (optional).")
    parser.add_argument(
        "--override",
        action="store_true",
        help="Include rows that already have both min_price and max_price set.",
    )
    parser.add_argument("--timeout", type=int, default=120, help="Subprocess timeout seconds.")
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=0,
        help="Pause after each successful gflights run per worker (rate limit).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=4,
        help="Parallel worker threads (each runs gflights subprocess).",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=4,
        help="Per-route attempts (1 = no retry). Exponential backoff between attempts.",
    )
    parser.add_argument(
        "--backoff-base-sec",
        type=float,
        default=1.0,
        help="First retry wait in seconds (then 2x, capped by --backoff-max-sec).",
    )
    parser.add_argument(
        "--backoff-max-sec",
        type=float,
        default=60.0,
        help="Cap on backoff delay between attempts.",
    )
    parser.add_argument(
        "--gflights-python",
        default=os.getenv("GFLIGHTS_PYTHON", "python3"),
        help="Python executable for gflights (default: env GFLIGHTS_PYTHON or python3).",
    )
    parser.add_argument(
        "--gflights-script",
        default=os.getenv("GFLIGHTS_SCRIPT", ""),
        help="Path to gflights.py (default: env GFLIGHTS_SCRIPT; required unless set).",
    )
    parser.add_argument(
        "--default-return-days",
        type=int,
        default=7,
        help="When a roundtrip row is missing/invalid arriveDate, default return date = departDate + N days.",
    )
    args = parser.parse_args(list(argv))

    script_path = args.gflights_script.strip()
    if not script_path:
        print(
            "error: set --gflights-script or GFLIGHTS_SCRIPT to the path of gflights.py",
            file=sys.stderr,
        )
        return 2
    if not Path(script_path).is_file():
        print(f"error: gflights script not found: {script_path}", file=sys.stderr)
        return 2

    sb = _create_supabase()
    regions = load_airport_region_map(sb)
    candidates, defaulted_depart, defaulted_return = fetch_candidates(
        sb,
        limit=args.limit,
        origin_filter=args.origin.strip() or None,
        destination_filter=args.destination.strip() or None,
        override_existing_minmax=args.override,
        airport_regions=regions,
        default_return_days=args.default_return_days,
    )
    if defaulted_depart:
        print(
            f"[info] missing/invalid departDate on {defaulted_depart} row(s); "
            f"using today+30 ({default_depart_date_str()}) for gflights"
        )
    if defaulted_return:
        print(
            f"[info] missing/invalid arriveDate on {defaulted_return} roundtrip row(s); "
            f"using departDate+{args.default_return_days} for gflights"
        )

    workers = max(1, args.workers)
    processed = updated = failed = 0
    run_kw = dict(
        gflights_python=args.gflights_python.strip(),
        gflights_script=script_path,
        timeout=args.timeout,
        max_attempts=args.max_attempts,
        backoff_base_sec=args.backoff_base_sec,
        backoff_max_sec=args.backoff_max_sec,
        sleep_after_success_ms=max(0, args.sleep_ms),
    )

    print(
        f"[parallel] workers={workers} jobs={len(candidates)} "
        f"gflights_python={args.gflights_python.strip()!r} script={script_path!r}"
    )

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(_fetch_one_route, row, **run_kw): row for row in candidates}
        for fut in as_completed(future_map):
            processed += 1
            outcome = fut.result()
            row = outcome.row
            if not outcome.band:
                failed += 1
                print(
                    f"[warn] {row.origin_iata}-{row.destination_iata} {row.roundtrip} "
                    f"depart={row.depart_date} return={row.return_date} "
                    f"after {outcome.attempts} attempt(s): {outcome.error}"
                )
                continue

            min_p, max_p = outcome.band
            patch = {"min_price": min_p, "max_price": max_p}
            if args.dry_run:
                print(
                    f"[DRY-RUN] id={row.id} {row.origin_iata}-{row.destination_iata} "
                    f"type={row.roundtrip} depart={row.depart_date} return={row.return_date} "
                    f"min={min_p} max={max_p}"
                )
            else:
                sb.table("google_flights_explore_destination_prices").update(patch).eq("id", row.id).execute()
                print(
                    f"[ok] id={row.id} {row.origin_iata}-{row.destination_iata} "
                    f"type={row.roundtrip} depart={row.depart_date} return={row.return_date} "
                    f"min={min_p} max={max_p}"
                )
            updated += 1

    print(f"[summary] processed={processed} updated_or_logged={updated} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        raise SystemExit(130)
