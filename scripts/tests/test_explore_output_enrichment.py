"""Regression tests for Explore output metadata enrichment (dates + airlines)."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

_CAP_PATH = Path(__file__).resolve().parent.parent / "google-flights-calendar-capture.py"
_spec = importlib.util.spec_from_file_location("gfcapture_enrichment", _CAP_PATH)
assert _spec and _spec.loader
_gfc = importlib.util.module_from_spec(_spec)
sys.modules["gfcapture_enrichment"] = _gfc
_spec.loader.exec_module(_gfc)

extract_explore_destination_metadata = _gfc.extract_explore_destination_metadata
parse_explore_csv_row_for_supabase = _gfc.parse_explore_csv_row_for_supabase
extract_non_multi_airline_google_pairs = _gfc.extract_non_multi_airline_google_pairs


class TestExploreOutputEnrichment(unittest.TestCase):
    def test_extracts_non_multi_iata_to_google_name_pairs(self) -> None:
        body = (
            r'[[null,2874],\"CjRIXdummy\"],null,null,null,null,['
            r'\"JL\",\"JAL\",1,1170,null,\"SAN\",\"/m/0dlv0\",null,0],'
            r'[\"EY\",\"Etihad\",1,1590,null,\"YYZ\",\"/m/0dlv0\",null,0],'
            r'[\"multi\",\"Air Canada and Air India\",2,1575,null,\"PVR\",\"/m/0dlv0\",null,0]'
        )
        pairs = extract_non_multi_airline_google_pairs(body)
        self.assertEqual(pairs.get("JL"), "JAL")
        self.assertEqual(pairs.get("EY"), "Etihad")
        self.assertNotIn("multi", {k.lower() for k in pairs.keys()})

    def test_roundtrip_dates_and_single_airline_code(self) -> None:
        body = (
            r'\"2026-08-14\",\"2026-08-20\",null,false,\"YVR\"'
            r'[[null,2658],\"CjRIXdummy\"],null,null,null,null,['
            r'\"NH\",\"ANA\",1,2000,null,\"YVR\",\"/m/0dlv0\",null,0]'
        )
        meta = extract_explore_destination_metadata(
            body,
            trip_type_token="roundtrip",
            known_airline_codes={"NH"},
            google_name_to_code={},
        )
        row = parse_explore_csv_row_for_supabase(
            "DEL,YVR,2658,roundtrip,j",
            destination_metadata=meta,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row.get("departDate"), "2026-08-14")
        self.assertEqual(row.get("arriveDate"), "2026-08-20")
        self.assertEqual(row.get("airlines"), ["NH"])

    def test_oneway_arrive_date_is_null(self) -> None:
        body = (
            r'\"2026-05-02\",\"2026-05-11\",null,false,\"HNL\"'
            r'[[null,2868],\"CjRIXdummy\"],null,null,null,null,['
            r'\"JL\",\"JAL\",1,1795,null,\"HNL\",\"/m/0dlv0\",null,0]'
        )
        meta = extract_explore_destination_metadata(
            body,
            trip_type_token="oneway",
            known_airline_codes={"JL"},
            google_name_to_code={},
        )
        row = parse_explore_csv_row_for_supabase(
            "DEL,HNL,2868,oneway,j",
            destination_metadata=meta,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row.get("departDate"), "2026-05-02")
        self.assertIsNone(row.get("arriveDate"))
        self.assertEqual(row.get("airlines"), ["JL"])

    def test_multi_two_airlines_maps_google_names(self) -> None:
        body = (
            r'[[null,1575],\"CjRIXdummy\"],null,null,null,null,['
            r'\"multi\",\"Air Canada and Air India\",2,1575,null,\"PVR\",\"/m/0dlv0\",null,0]'
        )
        meta = extract_explore_destination_metadata(
            body,
            trip_type_token="roundtrip",
            known_airline_codes=set(),
            google_name_to_code={
                "air canada": "AC",
                "air india": "AI",
            },
        )
        row = parse_explore_csv_row_for_supabase(
            "DEL,PVR,1575,roundtrip,j",
            destination_metadata=meta,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row.get("airlines"), ["AC", "AI"])

    def test_multi_three_airlines_maps_google_names(self) -> None:
        body = (
            r'[[null,5328],\"CjRIXdummy\"],null,null,null,null,['
            r'\"multi\",\"Alaska, Delta, and Korean Air\",2,2475,null,\"FAI\",\"/m/0dlv0\",null,0]'
        )
        meta = extract_explore_destination_metadata(
            body,
            trip_type_token="roundtrip",
            known_airline_codes=set(),
            google_name_to_code={
                "alaska": "AS",
                "delta": "DL",
                "korean air": "KE",
            },
        )
        row = parse_explore_csv_row_for_supabase(
            "DEL,FAI,5328,roundtrip,j",
            destination_metadata=meta,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row.get("airlines"), ["AS", "DL", "KE"])


if __name__ == "__main__":
    unittest.main()
