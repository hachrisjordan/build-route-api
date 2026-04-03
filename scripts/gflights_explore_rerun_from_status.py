from __future__ import annotations

import sys
from typing import List, Set

from ogfiles import (
    get_supabase_explore_pairing_status_table,
    get_supabase_write_credentials,
)


def _usage() -> None:
    print(
        "Usage: python -m gflights_explore_rerun_from_status <explore_run_id> "
        "[trip_type]\n"
        "  <explore_run_id>: UUID printed as explore_run_id=... by gflights_explore.py\n"
        "  [trip_type]: optional, 'roundtrip' (default) or 'oneway'; any other value = both.",
        file=sys.stderr,
    )


def main(argv: List[str]) -> int:
    if len(argv) < 2:
        _usage()
        return 1

    run_id = argv[1].strip()
    trip_type_filter = (argv[2].strip().lower() if len(argv) > 2 else "roundtrip") or "roundtrip"

    try:
        from supabase import create_client
    except ImportError:
        print("Missing dependency: supabase. Install with: pip install supabase", file=sys.stderr)
        return 1

    try:
        url, key = get_supabase_write_credentials()
    except ValueError as error:
        print(f"Supabase credentials error: {error}", file=sys.stderr)
        return 1

    client = create_client(url, key)

    pairing_table = get_supabase_explore_pairing_status_table()

    try:
        query = (
            client.table(pairing_table)
            .select("origin_iata, destination_region, trip_type, status")
            .eq("run_id", run_id)
        )
        if trip_type_filter in {"roundtrip", "oneway"}:
            query = query.eq("trip_type", trip_type_filter)
        resp = query.execute()
        rows = getattr(resp, "data", None) or []
    except Exception as exc:  # noqa: BLE001
        print(
            f"Supabase query failed on table {pairing_table!r}: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1

    if not rows:
        print(
            f"No pairing status rows found for run_id={run_id!r} in table {pairing_table!r}.",
            file=sys.stderr,
        )
        return 1

    failed_origins: Set[str] = set()
    for row in rows:
        origin = (row.get("origin_iata") or "").strip().upper()
        status = (row.get("status") or "").strip().lower()
        if not origin:
            continue
        if status != "success":
            failed_origins.add(origin)

    if not failed_origins:
        print(f"All origins for run_id={run_id} are marked success in pairing status.")
        return 0

    origins_csv = ",".join(sorted(failed_origins))
    print(f"Failed / partial origins for run_id={run_id} (table: {pairing_table}):")
    print(origins_csv)
    print()
    print(
        "Suggested rerun command (copy/paste):\n"
        f"  python gflights_explore.py {origins_csv} business --quiet --supabase"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

