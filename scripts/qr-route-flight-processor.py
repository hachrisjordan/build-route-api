#!/usr/bin/env python3
"""
Multi-Carrier Route Flight Processor
Fetches routes from Supabase for multiple carriers (QR, CX, EY, SQ),
gets flight numbers via route-validity API, and processes each flight via flightradar24 API.
"""

import os
import sys
import json
import time
import requests
import argparse
from typing import List, Dict, Set, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

# Load environment variables with graceful fallback (like finnair-auth.py)
try:
    from dotenv import load_dotenv
    # Look for .env file in the parent directory (main project root)
    parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(parent_dir, '.env')
    if os.path.exists(env_path):
        load_dotenv(env_path)
        # Debug: verify loading worked
        if os.getenv('SUPABASE_URL') or os.getenv('NEXT_PUBLIC_SUPABASE_URL'):
            pass  # Variables loaded successfully
        else:
            print(f"⚠️  Warning: .env file found at {env_path} but Supabase vars not loaded")
    else:
        print(f"⚠️  Warning: .env file not found at {env_path}")
except ImportError:
    # dotenv not available - will use system environment variables
    print("⚠️  python-dotenv not installed. Install with: pip install python-dotenv")
except Exception as e:
    # .env file might not exist - will use system environment variables
    print(f"⚠️  Could not load .env file: {e}")

try:
    from supabase import create_client, Client
except ImportError:
    print("❌ Failed to import Supabase client. Please install: pip install supabase")
    sys.exit(1)


class MultiCarrierRouteFlightProcessor:
    """Processes multiple airline routes by fetching flight numbers and calling FlightRadar24 API"""
    
    def __init__(self, carriers: List[str] = None, use_db_flight_numbers: bool = False):
        self.supabase = None
        self.api_url = os.getenv('API_URL', 'http://localhost:3000')
        self.carriers = carriers or ['QR', 'CX', 'EY', 'SQ']  # Default carriers
        self.use_db_flight_numbers = use_db_flight_numbers
        self.routes: List[Dict[str, str]] = []  # List of {Origin, Destination, Airline}
        self.flight_combinations: Set[Tuple[str, str, str]] = set()  # (flight_number, origin, destination)
        self.processed_routes = 0
        self.processed_flights = 0
        self.errors = []
        
    def initialize_supabase(self) -> bool:
        """Initialize Supabase client with environment variables"""
        try:
            supabase_url = (
                os.getenv('SUPABASE_URL') or 
                os.getenv('NEXT_PUBLIC_SUPABASE_URL')
            )
            supabase_key = (
                os.getenv('SUPABASE_SERVICE_ROLE_KEY') or 
                os.getenv('SUPABASE_ANON_KEY') or
                os.getenv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
            )
            
            if not supabase_url or not supabase_key:
                print("❌ Missing Supabase configuration")
                print("Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env file")
                print("   Or use NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY")
                return False
            
            self.supabase = create_client(supabase_url, supabase_key)
            print(f"✅ Supabase client initialized (URL: {supabase_url})")
            return True
            
        except Exception as e:
            print(f"❌ Failed to initialize Supabase client: {e}")
            return False
    
    def fetch_routes(self) -> bool:
        """Fetch all routes for specified carriers from Supabase"""
        try:
            print(f"\n📖 Fetching routes from Supabase for carriers: {', '.join(self.carriers)}...")
            
            all_routes = []
            for carrier in self.carriers:
                result = self.supabase.table('routes')\
                    .select('Origin,Destination,Airline')\
                    .eq('Airline', carrier)\
                    .execute()
                
                if result.data:
                    # Add airline code to each route
                    carrier_routes = [{**route, 'Airline': carrier} for route in result.data]
                    all_routes.extend(carrier_routes)
                    print(f"  ✅ Found {len(carrier_routes)} {carrier} routes")
                else:
                    print(f"  ⚠️  No {carrier} routes found in database")
            
            if not all_routes:
                print("⚠️  No routes found for any carrier")
                return False
            
            self.routes = all_routes
            total_routes = len(self.routes)
            print(f"\n✅ Found {total_routes} total routes across {len(self.carriers)} carrier(s)")
            return True
            
        except Exception as e:
            print(f"❌ Error fetching routes: {e}")
            self.errors.append(f"Route fetch error: {e}")
            return False
    
    def fetch_flight_numbers_from_db(self) -> bool:
        """Fetch existing flight numbers from database that start with carrier codes"""
        try:
            print(f"\n📖 Fetching existing flight numbers from database for carriers: {', '.join(self.carriers)}...")
            
            all_combinations = set()
            
            for carrier in self.carriers:
                # Query distinct flight_number, origin_iata, destination_iata combinations
                # where flight_number starts with the carrier code
                result = self.supabase.table('flight_data')\
                    .select('flight_number,origin_iata,destination_iata')\
                    .ilike('flight_number', f'{carrier}%')\
                    .execute()
                
                if result.data:
                    carrier_combinations = set()
                    for row in result.data:
                        flight_number = row.get('flight_number')
                        origin = row.get('origin_iata')
                        destination = row.get('destination_iata')
                        
                        if flight_number and origin and destination:
                            combination = (flight_number, origin, destination)
                            carrier_combinations.add(combination)
                            all_combinations.add(combination)
                    
                    print(f"  ✅ Found {len(carrier_combinations)} unique {carrier} flight combinations")
                else:
                    print(f"  ⚠️  No {carrier} flight numbers found in database")
            
            if not all_combinations:
                print("⚠️  No flight numbers found in database for any carrier")
                return False
            
            self.flight_combinations = all_combinations
            total_combinations = len(self.flight_combinations)
            print(f"\n✅ Found {total_combinations} total unique flight combinations across {len(self.carriers)} carrier(s)")
            return True
            
        except Exception as e:
            print(f"❌ Error fetching flight numbers from database: {e}")
            self.errors.append(f"Database flight number fetch error: {e}")
            return False
    
    def call_route_validity(self, origin: str, destination: str, airline: str, retries: int = 3) -> List[str]:
        """Call route-validity API and extract distinct flight numbers with retry logic"""
        url = f"{self.api_url}/api/route-validity"
        payload = {
            "dep": origin,
            "des": destination,
            "airline": airline
        }
        
        for attempt in range(retries):
            try:
                response = requests.post(url, json=payload, timeout=30)
                
                # Retry on 500 errors
                if response.status_code == 500 and attempt < retries - 1:
                    wait_time = (attempt + 1) * 2  # Exponential backoff: 2s, 4s, 6s
                    time.sleep(wait_time)
                    continue
                
                response.raise_for_status()
                
                data = response.json()
                
                if not data.get('success'):
                    return []
                
                flights = data.get('flights', [])
                flight_numbers = []
                
                for flight in flights:
                    flight_number = flight.get('flightnumber')
                    if flight_number:
                        flight_numbers.append(flight_number)
                        # Track unique combinations (thread-safe due to GIL)
                        self.flight_combinations.add((flight_number, origin, destination))
                
                return list(set(flight_numbers))  # Return unique flight numbers
                
            except requests.exceptions.RequestException as e:
                if attempt < retries - 1:
                    wait_time = (attempt + 1) * 2
                    time.sleep(wait_time)
                    continue
                error_msg = f"API error for {origin}-{destination}: {e}"
                self.errors.append(error_msg)
                return []
            except Exception as e:
                if attempt < retries - 1:
                    wait_time = (attempt + 1) * 2
                    time.sleep(wait_time)
                    continue
                error_msg = f"Unexpected error for {origin}-{destination}: {e}"
                self.errors.append(error_msg)
                return []
        
        return []
    
    def call_flightradar24(self, flight_number: str, origin: str, destination: str, ignore_existing: bool = True) -> bool:
        """Call flightradar24 API for a specific flight number and route
        
        Args:
            flight_number: Flight number to query
            origin: Origin airport IATA code
            destination: Destination airport IATA code
            ignore_existing: If True, ignores existing database dates and fetches fresh data
        """
        url = f"{self.api_url}/api/flightradar24/{flight_number}"
        params = {
            "origin": origin,
            "destination": destination,
            "ignoreExisting": "true" if ignore_existing else "false"
        }
        
        try:
            response = requests.get(url, params=params, timeout=120)
            response.raise_for_status()
            
            data = response.json()
            
            # The API returns an array of flight data
            flight_count = len(data) if isinstance(data, list) else 1
            print(f"    ✅ FlightRadar24: {flight_count} flight record(s) retrieved")
            return True
            
        except requests.exceptions.RequestException as e:
            error_msg = f"FlightRadar24 API error for {flight_number} ({origin}-{destination}): {e}"
            print(f"    ❌ {error_msg}")
            self.errors.append(error_msg)
            return False
        except Exception as e:
            error_msg = f"Unexpected error for {flight_number} ({origin}-{destination}): {e}"
            print(f"    ❌ {error_msg}")
            self.errors.append(error_msg)
            return False
    
    def process_route_wrapper(self, route: Dict[str, str], idx: int) -> Tuple[int, str, str, str, List[str]]:
        """Wrapper function for concurrent route processing"""
        origin = route.get('Origin')
        destination = route.get('Destination')
        airline = route.get('Airline', 'CX')  # Default to CX if not specified
        
        if not origin or not destination:
            return (idx, origin or 'N/A', destination or 'N/A', airline, [])
        
        flight_numbers = self.call_route_validity(origin, destination, airline)
        return (idx, origin, destination, airline, flight_numbers)
    
    def process_routes(self):
        """Process all routes: fetch flight numbers via route-validity API (10 concurrent to avoid API blocking)"""
        print(f"\n🔄 Processing {len(self.routes)} routes concurrently (10 per batch to avoid API rate limits)...")
        
        batch_size = 10  # Reduced from 36 to avoid FlightConnections API 405 errors
        max_retries = 5
        total_routes = len(self.routes)
        processed_count = 0
        
        # Process routes in batches of 36
        for batch_start in range(0, total_routes, batch_size):
            batch_end = min(batch_start + batch_size, total_routes)
            batch_routes = self.routes[batch_start:batch_end]
            batch_num = (batch_start // batch_size) + 1
            total_batches = (total_routes + batch_size - 1) // batch_size
            
            print(f"\n📦 Batch {batch_num}/{total_batches}: Processing routes {batch_start+1}-{batch_end}")
            
            with ThreadPoolExecutor(max_workers=batch_size) as executor:
                # Submit all tasks in this batch
                future_to_route = {
                    executor.submit(self.process_route_wrapper, route, batch_start + i + 1): (batch_start + i + 1, route)
                    for i, route in enumerate(batch_routes)
                }
                
                # Process completed tasks as they finish
                for future in as_completed(future_to_route):
                    idx, route = future_to_route[future]
                    try:
                        route_idx, origin, destination, airline, flight_numbers = future.result()
                        
                        if flight_numbers:
                            print(f"  [{route_idx}/{total_routes}] {airline} {origin} → {destination}: ✅ {len(flight_numbers)} flight(s) - {', '.join(flight_numbers)}")
                        else:
                            print(f"  [{route_idx}/{total_routes}] {airline} {origin} → {destination}: ⚠️  No flights found")
                        
                        self.processed_routes += 1
                        processed_count += 1
                        
                    except Exception as e:
                        error_msg = f"Error processing route {idx}: {e}"
                        print(f"  ❌ {error_msg}")
                        self.errors.append(error_msg)
                        self.processed_routes += 1
                        processed_count += 1
            
            # Longer delay between batches to avoid overwhelming the API
            if batch_end < total_routes:
                time.sleep(5)  # Increased delay to give server time to recover
        
        print(f"\n✅ Route processing complete: {processed_count}/{total_routes} routes processed")
        print(f"📊 Total unique flight combinations: {len(self.flight_combinations)}")
    
    def process_flightradar24(self):
        """Process all unique flight number + origin + destination combinations"""
        combinations_list = list(self.flight_combinations)
        
        if not combinations_list:
            print("\n⚠️  No flight combinations to process")
            return
        
        print(f"\n🔄 Processing {len(combinations_list)} FlightRadar24 API calls...")
        
        for idx, (flight_number, origin, destination) in enumerate(combinations_list, 1):
            print(f"\n[{idx}/{len(combinations_list)}] Processing: {flight_number} ({origin} → {destination})")
            
            self.call_flightradar24(flight_number, origin, destination)
            self.processed_flights += 1
            
            # Small delay to avoid overwhelming the API
            time.sleep(1)
        
        print(f"\n✅ FlightRadar24 processing complete: {self.processed_flights}/{len(combinations_list)} flights processed")
    
    def print_summary(self):
        """Print final summary of processing"""
        print("\n" + "="*60)
        print("📊 PROCESSING SUMMARY")
        print("="*60)
        print(f"Routes processed: {self.processed_routes}")
        print(f"Unique flight combinations: {len(self.flight_combinations)}")
        print(f"FlightRadar24 calls: {self.processed_flights}")
        print(f"Errors encountered: {len(self.errors)}")
        
        if self.errors:
            print(f"\n⚠️  Errors ({len(self.errors)}):")
            for error in self.errors[:10]:  # Show first 10 errors
                print(f"  - {error}")
            if len(self.errors) > 10:
                print(f"  ... and {len(self.errors) - 10} more errors")
        
        print("="*60)
    
    def run(self):
        """Main execution flow"""
        print("🚀 Multi-Carrier Route Flight Processor")
        print("="*60)
        print(f"📋 Processing carriers: {', '.join(self.carriers)}")
        
        if self.use_db_flight_numbers:
            print("📌 Mode: Using existing flight numbers from database")
        else:
            print("📌 Mode: Scraping flight numbers via route-validity API")
        
        # Step 1: Initialize Supabase
        if not self.initialize_supabase():
            print("❌ Failed to initialize Supabase. Exiting.")
            return False
        
        # Step 2: Either fetch routes and scrape flight numbers, or use existing flight numbers from DB
        if self.use_db_flight_numbers:
            # Use existing flight numbers from database
            if not self.fetch_flight_numbers_from_db():
                print("❌ Failed to fetch flight numbers from database. Exiting.")
                return False
        else:
            # Fetch routes and scrape flight numbers via API
            if not self.fetch_routes():
                print("❌ Failed to fetch routes. Exiting.")
                return False
            
            # Step 3: Process routes and get flight numbers
            self.process_routes()
        
        # Step 4: Process FlightRadar24 API calls
        if self.flight_combinations:
            self.process_flightradar24()
        else:
            print("\n⚠️  No flight combinations found. Skipping FlightRadar24 processing.")
        
        # Step 5: Print summary
        self.print_summary()
        
        return True


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='Multi-Carrier Route Flight Processor',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Scrape flight numbers via route-validity API (default)
  python3 scripts/qr-route-flight-processor.py QR CX EY SQ
  
  # Use existing flight numbers from database
  python3 scripts/qr-route-flight-processor.py --use-db-flight-numbers QR CX EY SQ
  
  # Use database flight numbers with default carriers
  python3 scripts/qr-route-flight-processor.py --use-db-flight-numbers
        """
    )
    
    parser.add_argument(
        '--use-db-flight-numbers',
        action='store_true',
        help='Use existing flight numbers from database instead of scraping via route-validity API'
    )
    
    parser.add_argument(
        'carriers',
        nargs='*',
        help='Carrier codes to process (default: QR CX EY SQ if not specified)'
    )
    
    args = parser.parse_args()
    
    # Validate carrier codes and use defaults if none provided
    valid_carriers = ['QR', 'CX', 'EY', 'SQ']
    
    if not args.carriers:
        # No carriers specified, use defaults
        carriers = ['QR', 'CX', 'EY', 'SQ']
    else:
        # Filter and validate provided carriers
        carriers = [carrier.upper() for carrier in args.carriers if carrier.upper() in valid_carriers]
        if not carriers:
            print("⚠️  Invalid carrier codes. Using defaults: QR, CX, EY, SQ")
            carriers = ['QR', 'CX', 'EY', 'SQ']
    
    processor = MultiCarrierRouteFlightProcessor(
        carriers=carriers,
        use_db_flight_numbers=args.use_db_flight_numbers
    )
    success = processor.run()
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
