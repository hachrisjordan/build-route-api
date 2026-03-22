#!/usr/bin/env python3
"""
Parse Google Travel Explore GetExploreDestinations response body into CSV-ish rows.

Expected output row format:
  <origin>,<destination>,<price>,roundtrip,j

This is intentionally heuristic because Google returns a nested array blob (often wrapped
with non-JSON prefixes, and with large portions embedded as string fragments).

Heuristic used:
- Find occurrences of fare price markers shaped like: `[[null,<PRICE>],"CjRIX...`
- For each marker, look forward and pick the first escaped IATA code: `\"XXX\"`
  (excluding the origin IATA).
- Keep the minimum price per IATA and print sorted-by-price rows.
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Optional


IATA_RE = re.compile(r"^[A-Z]{3}$")

# Escaped IATA codes as they appear in this blob: \"LHR\"
# In the blob it shows up like: \\"LHR\\"
ESCAPED_IATA_RE = re.compile(r"\\\"([A-Z]{3})\\\"")


def extract_pairs(body_text: str, origin_iata: str) -> list[tuple[str, int]]:
    """
    Extract (destination_iata, price) pairs from the raw response body string.
    """
    # Price markers we observed for destination fare blocks:
    #   [[null,<PRICE>],\"CjRIX...   (older)
    #   [[null,<PRICE>],\"CjRIY...   (newer)
    # In the on-disk blob it appears literally as: [[null,1661],\"CjRIY...
    # NOTE: the blob contains literal `[[null,1661],\"CjRIY...`.
    # In the on-disk representation this is the escaped sequence:
    #   \[\[null,<PRICE>\],\\\"CjRIX
    # We only anchor on the stable `[[null,<PRICE>],\"CjRI` prefix.
    price_marker_re = re.compile(r"\[\[null,(\d+)\],\\\"CjRI[A-Za-z]")

    best_price_by_iata: dict[str, int] = {}
    for m in price_marker_re.finditer(body_text):
        price = int(m.group(1))
        # Look ahead: we want the first escaped IATA code after the marker.
        window = body_text[m.end() : m.end() + 25000]
        cm = ESCAPED_IATA_RE.search(window)
        if not cm:
            continue
        iata = cm.group(1)
        if iata == origin_iata:
            continue
        prev = best_price_by_iata.get(iata)
        if prev is None or price < prev:
            best_price_by_iata[iata] = price

    return sorted(best_price_by_iata.items(), key=lambda kv: kv[1])


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse Google Explore GetExploreDestinations body blob.")
    parser.add_argument("--origin", required=True, type=str, help="Origin IATA (e.g. SGN)")
    parser.add_argument("--body", required=True, type=str, help="Path to explore-body.json (raw CDP body)")
    parser.add_argument(
        "--limit",
        required=False,
        type=int,
        default=-1,
        help="Max rows to print (sorted by price asc). Use -1 to print all.",
    )
    parser.add_argument(
        "--only",
        required=False,
        type=str,
        default=None,
        help="Comma-separated destination IATA codes to include (e.g. LHR,CDG). If omitted, prints top N.",
    )
    args = parser.parse_args()

    origin = args.origin.strip().upper()
    if not IATA_RE.match(origin):
        raise SystemExit(f"origin must be 3-letter IATA, got: {args.origin!r}")

    with open(args.body, "r", encoding="utf-8") as f:
        body_text = f.read()

    pairs = extract_pairs(body_text, origin_iata=origin)

    if args.only:
        only_set = {
            x.strip().upper()
            for x in args.only.split(",")
            if x.strip()
        }
        pairs = [p for p in pairs if p[0] in only_set]

    limit = int(args.limit)
    if limit == -1:
        out = pairs
    else:
        out = pairs[: max(0, limit)]
    for dest_iata, price in out:
        print(f"{origin},{dest_iata},{price},roundtrip,j")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

