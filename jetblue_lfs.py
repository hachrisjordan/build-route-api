#!/usr/bin/env python3
"""
jetblue_lfs.py

Script to query JetBlue's outboundLFS endpoint, parse the response, and import data into Supabase tables.
Usage:
    python jetblue_lfs.py --from JFK --to BKK --depart 2025-07-04

Environment variables required:
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
"""
import argparse
import requests
import sys
import uuid
import json
import os
from datetime import datetime
from dateutil import parser as dtparser
import isodate
import re
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

# Use the microservice instead of direct API call
JETBLUE_LFS_URL = 'http://localhost:4000/jetblue'

def get_headers(from_airport, to_airport, depart_date):
    return {
        'Content-Type': 'application/json',
    }

def iso_duration_to_minutes(duration_str):
    try:
        duration = isodate.parse_duration(duration_str)
        return int(duration.total_seconds() // 60)
    except Exception:
        return None

def remove_timezone(dt_str):
    # Remove timezone info from ISO string
    if dt_str is None:
        return None
    try:
        dt = dtparser.isoparse(dt_str)
        return dt.replace(tzinfo=None).isoformat()
    except Exception:
        # fallback: remove trailing timezone manually
        return re.sub(r"([\+\-][0-9]{2}:?[0-9]{2}|Z)$", "", dt_str)

def normalize_cabinclass(cabinclass):
    if cabinclass == 'C':
        return 'business'
    if cabinclass == 'Y':
        return 'economy'
    if cabinclass == 'F':
        return 'first'
    if cabinclass == 'P':
        return 'economy'
    return cabinclass

def parse_itinerary(itinerary):
    return {
        "id": str(uuid.uuid4()),
        "from": itinerary.get("from"),
        "to": itinerary.get("to"),
        "connections": itinerary.get("connections", []),
        "depart": remove_timezone(itinerary.get("depart")),
        "arrive": remove_timezone(itinerary.get("arrive")),
        "duration": iso_duration_to_minutes(itinerary.get("duration")),
        "price": [
            {
                "points": b.get("points"),
                "fareTax": b.get("fareTax"),
                "cabinclass": normalize_cabinclass(b.get("cabinclass")),
                "inventoryQuantity": b.get("inventoryQuantity") if b.get("inventoryQuantity") is not None else 6,
            }
            for b in itinerary.get("bundles", [])
        ],
        "segments": [
            {
                "id": s.get("id"),
                "from_airport": s.get("from"),
                "to_airport": s.get("to"),
                "aircraft": s.get("aircraft"),
                "depart": remove_timezone(s.get("depart")),
                "arrive": remove_timezone(s.get("arrive")),
                "flightno": s.get("flightno", "").replace(" ", ""),
                "duration": iso_duration_to_minutes(s.get("duration")),
                "layover": iso_duration_to_minutes(s.get("layover")) if s.get("layover") else None,
                "bookingclass": s.get("bookingclass"),
                "cabinclass": normalize_cabinclass(s.get("cabinclass")),
                "operating_airline_code": s.get("operatingAirlineCode"),
                "distance": s.get("distance"),
            }
            for s in itinerary.get("segments", [])
        ]
    }

def upsert_segments(supabase: Client, segments):
    for seg in segments:
        # Upsert by id (overwrite if exists)
        res = supabase.table("segments").upsert(seg, on_conflict="id").execute()
        if res.get('status_code', 200) >= 400:
            print(f"Failed to upsert segment {seg['id']}: {res}", file=sys.stderr)

def upsert_itinerary(supabase: Client, itin):
    itin_db = {
        "id": itin["id"],
        "from_airport": itin["from"],
        "to_airport": itin["to"],
        "connections": itin["connections"],
        "depart": itin["depart"],
        "arrive": itin["arrive"],
        "duration": itin["duration"],
        "price": json.dumps(itin["price"]),
        "segment_ids": [seg["id"] for seg in itin["segments"]],
    }
    res = supabase.table("itinerary").upsert(itin_db, on_conflict="id").execute()
    if res.get('status_code', 200) >= 400:
        print(f"Failed to upsert itinerary {itin['id']}: {res}", file=sys.stderr)

def main():
    parser = argparse.ArgumentParser(description='Query JetBlue outboundLFS API.')
    parser.add_argument('--from', dest='from_airport', required=True, help='Origin airport code (e.g., JFK)')
    parser.add_argument('--to', dest='to_airport', required=True, help='Destination airport code (e.g., BKK)')
    parser.add_argument('--depart', dest='depart_date', required=True, help='Departure date (YYYY-MM-DD)')
    args = parser.parse_args()

    payload = {
        "from": args.from_airport,
        "to": args.to_airport,
        "depart": args.depart_date,
        "ADT": 1
    }

    try:
        headers = get_headers(args.from_airport, args.to_airport, args.depart_date)
        response = requests.post(JETBLUE_LFS_URL, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        
        # Handle new API response format
        itineraries = []
        if data.get("status", {}).get("transactionStatus") == "success" and data.get("data", {}).get("searchResults"):
            # New API format - extract from searchResults
            for result in data["data"]["searchResults"]:
                for offer in result.get("productOffers", []):
                    for route in offer.get("originAndDestination", []):
                        firstSegment = route.get("flightSegments", [{}])[0]
                        lastSegment = route.get("flightSegments", [{}])[-1]
                        price = offer.get("offers", [{}])[0].get("price", [])
                        
                        # Map to old format structure
                        connections = []
                        if route.get("flightSegments") and len(route["flightSegments"]) > 1:
                            for i in range(len(route["flightSegments"]) - 1):
                                currSeg = route["flightSegments"][i]
                                nextSeg = route["flightSegments"][i + 1]
                                if currSeg.get("arrival", {}).get("airport") and nextSeg.get("departure", {}).get("airport"):
                                    if currSeg["arrival"]["airport"] != nextSeg["departure"]["airport"]:
                                        connections.append(f"{currSeg['arrival']['airport']}/{nextSeg['departure']['airport']}")
                                    else:
                                        connections.append(currSeg["arrival"]["airport"])
                        
                        # Only include business class results for LFS
                        cabin_class = offer.get("offers", [{}])[0].get("cabinClass")
                        if cabin_class not in ["Business", "First"]:
                            continue  # Skip non-business class results

                        itinerary = {
                            "from": firstSegment.get("departure", {}).get("airport") or route.get("departure", {}).get("airport"),
                            "to": lastSegment.get("arrival", {}).get("airport") or route.get("arrival", {}).get("airport"),
                            "connections": connections,
                            "depart": route.get("departure", {}).get("date") or firstSegment.get("departure", {}).get("date"),
                            "arrive": route.get("arrival", {}).get("date") or lastSegment.get("arrival", {}).get("date"),
                            "duration": route.get("totalDuration", 0),
                            "bundles": [{
                                "class": "F" if cabin_class == "First" else "C",  # Map to airline codes
                                "points": next((p.get("amount") for p in price if p.get("currency") == "FFCURRENCY"), 0),
                                "fareTax": next((p.get("amount") for p in price if p.get("currency") == "USD"), 0),
                            }] if price else [],
                            "segments": [
                                {
                                    "id": segment.get("@id"),
                                    "from": segment.get("departure", {}).get("airport"),
                                    "to": segment.get("arrival", {}).get("airport"),
                                    "aircraft": segment.get("aircraft"),
                                    "stops": len(segment.get("stopAirport", [])),
                                    "depart": segment.get("departure", {}).get("date"),
                                    "arrive": segment.get("arrival", {}).get("date"),
                                    "flightno": f"{segment.get('flightInfo', {}).get('marketingAirlineCode', '')}{segment.get('flightInfo', {}).get('marketingFlightNumber', '')}",
                                    "duration": segment.get("duration", 0),
                                    "layover": segment.get("layoverDuration"),
                                    "distance": segment.get("distance", 0),
                                }
                                for segment in route.get("flightSegments", [])
                            ],
                        }
                        itineraries.append(itinerary)
        elif data.get("itinerary"):
            # Old API format fallback
            itineraries = data.get("itinerary", [])
        else:
            # No itineraries found
            itineraries = []
        
        parsed = [parse_itinerary(itin) for itin in itineraries]
        print(json.dumps({"itinerary": parsed}, indent=2))
    except requests.RequestException as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Parsing error: {e}", file=sys.stderr)
        sys.exit(2)

    # Supabase integration
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required.", file=sys.stderr)
        sys.exit(3)
    supabase: Client = create_client(supabase_url, supabase_key)

    total_segments = 0
    total_itineraries = 0
    for itin in parsed:
        upsert_segments(supabase, itin["segments"])
        upsert_itinerary(supabase, itin)
        total_segments += len(itin["segments"])
        total_itineraries += 1
    print(f"Upserted {total_itineraries} itineraries and {total_segments} segments to Supabase.")

if __name__ == '__main__':
    main() 