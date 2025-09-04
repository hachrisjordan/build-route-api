#!/usr/bin/env python3
"""
Cathay Pacific Availability Scraper

This script:
1. Fetches CX routes from Supabase
2. Queries Cathay Pacific API for availability data
3. Processes and filters the data (ignoring NA values)
4. Uploads results to Supabase CX table
"""

import os
import json
import requests
import asyncio
import aiohttp
from datetime import datetime, timedelta
from typing import List, Dict, Any, Tuple
import supabase
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor, as_completed
import time

# Load environment variables
load_dotenv()

class CXAvailabilityScraper:
    def __init__(self):
        """Initialize the scraper with Supabase connection"""
        self.supabase_url = os.getenv('NEXT_PUBLIC_SUPABASE_URL')
        self.supabase_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        
        if not self.supabase_url or not self.supabase_key:
            raise ValueError("Missing Supabase credentials. Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        
        self.supabase_client = supabase.create_client(self.supabase_url, self.supabase_key)
        
        # Cathay Pacific API base URL
        self.cx_api_base = "https://api.cathaypacific.com/afr/search/availability"
        
        # Classes to check
        self.classes = ['fir', 'bus']  # First and Business
        
        # Hardcoded combinations that need both fir and bus
        self.hardcoded_combinations = [
            ('HKG', 'LHR'), ('LHR', 'HKG'),
            ('HKG', 'CDG'), ('CDG', 'HKG'),
            ('HKG', 'LAX'), ('LAX', 'HKG'),
            ('HKG', 'JFK'), ('JFK', 'HKG'),
            ('HKG', 'PEK'), ('PEK', 'HKG'),
            ('HKG', 'HND'), ('HND', 'HKG')
        ]
        
        # Parallel processing settings
        self.max_workers = 20
        self.request_timeout = 30
        
    def get_cx_routes(self) -> List[Dict[str, Any]]:
        """Fetch all CX routes from Supabase"""
        try:
            response = self.supabase_client.table('routes').select('*').eq('Airline', 'CX').execute()
            return response.data
        except Exception as e:
            print(f"Error fetching CX routes: {e}")
            return []
    
    def get_date_range(self) -> tuple:
        """Get today's date and 364 days later"""
        today = datetime.now()
        end_date = today + timedelta(days=364)
        return today.strftime('%Y%m%d'), end_date.strftime('%Y%m%d')
    
    def build_api_url(self, origin: str, destination: str, class_type: str, start_date: str, end_date: str) -> str:
        """Build Cathay Pacific API URL"""
        return f"{self.cx_api_base}/en.{origin}.{destination}.{class_type}.CX.1.{start_date}.{end_date}.json"
    
    def query_cx_api_sync(self, origin: str, destination: str, class_type: str) -> Tuple[Dict[str, Any], int, str]:
        """Query Cathay Pacific API for availability (synchronous version for threading)"""
        start_date, end_date = self.get_date_range()
        url = self.build_api_url(origin, destination, class_type, start_date, end_date)
        
        try:
            print(f"Querying: {url}")
            response = requests.get(url, timeout=self.request_timeout)
            status_code = response.status_code
            print(f"Status Code: {status_code} for {origin}-{destination} {class_type}")
            
            if status_code == 200:
                return response.json(), status_code, ""
            else:
                print(f"Non-200 status code {status_code} for {origin}-{destination} {class_type}")
                return {}, status_code, f"HTTP {status_code}"
                
        except requests.exceptions.RequestException as e:
            print(f"Request error for {origin}-{destination} {class_type}: {e}")
            return {}, 0, str(e)
        except json.JSONDecodeError as e:
            print(f"JSON parsing error for {origin}-{destination} {class_type}: {e}")
            return {}, 200, f"JSON Error: {str(e)}"
    
    def process_availability_data(self, data: Dict[str, Any], origin: str, destination: str, class_type: str) -> List[Dict[str, Any]]:
        """Process availability data and filter out NA values"""
        processed_data = []
        
        if 'availabilities' not in data:
            return processed_data
        
        availabilities = data['availabilities']
        
        # Process standard availability (std)
        if 'std' in availabilities:
            for item in availabilities['std']:
                if item.get('availability') != 'NA':
                    processed_data.append({
                        'origin': origin,
                        'destination': destination,
                        'date': datetime.strptime(item['date'], '%Y%m%d').strftime('%Y-%m-%d'),
                        'class': class_type,
                        'availability': item['availability']
                    })
        
        # Process premium economy (pt1) if available
        if 'pt1' in availabilities and availabilities['pt1']:
            for item in availabilities['pt1']:
                if item.get('availability') != 'NA':
                    processed_data.append({
                        'origin': origin,
                        'destination': destination,
                        'date': datetime.strptime(item['date'], '%Y%m%d').strftime('%Y-%m-%d'),
                        'class': 'pt1',
                        'availability': item['availability']
                    })
        
        # Process economy (pt2) if available
        if 'pt2' in availabilities and availabilities['pt2']:
            for item in availabilities['pt2']:
                if item.get('availability') != 'NA':
                    processed_data.append({
                        'origin': origin,
                        'destination': destination,
                        'date': datetime.strptime(item['date'], '%Y%m%d').strftime('%Y-%m-%d'),
                        'class': 'pt2',
                        'availability': item['availability']
                    })
        
        return processed_data
    
    def truncate_cx_table(self) -> bool:
        """Truncate the CX table before inserting new data"""
        try:
            print("Truncating CX table...")
            # Delete all records from the cx table using a condition that matches all rows
            # We use a condition that will always be true for existing records
            response = self.supabase_client.table('cx').delete().gte('created_at', '1900-01-01').execute()
            print("Successfully truncated CX table")
            return True
        except Exception as e:
            print(f"Error truncating CX table: {e}")
            # Try alternative method if the first one fails
            try:
                print("Trying alternative truncation method...")
                # Get all records first, then delete them
                all_records = self.supabase_client.table('cx').select('id').execute()
                if all_records.data:
                    # Delete in batches to avoid hitting limits
                    batch_size = 100
                    for i in range(0, len(all_records.data), batch_size):
                        batch = all_records.data[i:i + batch_size]
                        ids = [record['id'] for record in batch]
                        self.supabase_client.table('cx').delete().in_('id', ids).execute()
                    print(f"Successfully truncated CX table using alternative method ({len(all_records.data)} records deleted)")
                else:
                    print("CX table is already empty")
                return True
            except Exception as e2:
                print(f"Alternative truncation method also failed: {e2}")
                return False
    
    def upload_to_supabase(self, data: List[Dict[str, Any]]) -> bool:
        """Upload processed data to Supabase CX table"""
        if not data:
            print("No data to upload")
            return True
        
        try:
            # Upload in batches to avoid hitting limits
            batch_size = 100
            for i in range(0, len(data), batch_size):
                batch = data[i:i + batch_size]
                response = self.supabase_client.table('cx').insert(batch).execute()
                print(f"Uploaded batch {i//batch_size + 1}: {len(batch)} records")
            
            print(f"Successfully uploaded {len(data)} records to Supabase")
            return True
        except Exception as e:
            print(f"Error uploading to Supabase: {e}")
            return False
    
    def run_scraper(self):
        """Main method to run the scraper with parallel processing"""
        print("Starting CX Availability Scraper with parallel processing...")
        print(f"Max concurrent requests: {self.max_workers}")
        
        # Truncate CX table before processing new data
        if not self.truncate_cx_table():
            print("Failed to truncate CX table. Aborting scraper run.")
            return
        
        # Get CX routes from Supabase
        cx_routes = self.get_cx_routes()
        print(f"Found {len(cx_routes)} CX routes")
        
        # Prepare all API requests
        api_requests = []
        
        # Add hardcoded combinations (both fir and bus)
        for origin, destination in self.hardcoded_combinations:
            for class_type in self.classes:  # Both fir and bus
                api_requests.append((origin, destination, class_type))
        
        # Add other CX routes from Supabase (bus only)
        for route in cx_routes:
            origin = route['Origin']
            destination = route['Destination']
            route_tuple = (origin, destination)
            
            # Skip if this route is already in hardcoded combinations
            if route_tuple not in self.hardcoded_combinations:
                # Only add bus class for other routes
                api_requests.append((origin, destination, 'bus'))
        
        print(f"Total API requests to process: {len(api_requests)}")
        
        # Process requests in parallel
        all_processed_data = []
        status_codes = {}
        start_time = time.time()
        
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit all requests
            future_to_request = {
                executor.submit(self.query_cx_api_sync, origin, destination, class_type): (origin, destination, class_type)
                for origin, destination, class_type in api_requests
            }
            
            # Process completed requests
            completed_requests = 0
            for future in as_completed(future_to_request):
                origin, destination, class_type = future_to_request[future]
                completed_requests += 1
                
                try:
                    data, status_code, error = future.result()
                    
                    # Track status codes
                    if status_code not in status_codes:
                        status_codes[status_code] = 0
                    status_codes[status_code] += 1
                    
                    # Process successful responses
                    if status_code == 200 and data:
                        processed_data = self.process_availability_data(
                            data, origin, destination, class_type
                        )
                        all_processed_data.extend(processed_data)
                        print(f"Processed {len(processed_data)} records from {origin}-{destination} {class_type}")
                    else:
                        print(f"No data processed for {origin}-{destination} {class_type} (Status: {status_code}, Error: {error})")
                        
                except Exception as e:
                    print(f"Exception processing {origin}-{destination} {class_type}: {e}")
                    if 0 not in status_codes:
                        status_codes[0] = 0
                    status_codes[0] += 1
                
                # Progress update
                if completed_requests % 5 == 0 or completed_requests == len(api_requests):
                    print(f"Progress: {completed_requests}/{len(api_requests)} requests completed")
        
        end_time = time.time()
        processing_time = end_time - start_time
        
        # Print summary
        print(f"\n=== PROCESSING SUMMARY ===")
        print(f"Total requests: {len(api_requests)}")
        print(f"Processing time: {processing_time:.2f} seconds")
        print(f"Average time per request: {processing_time/len(api_requests):.2f} seconds")
        print(f"Status code distribution:")
        for code, count in sorted(status_codes.items()):
            print(f"  {code}: {count} requests")
        print(f"Total processed records: {len(all_processed_data)}")
        
        # Upload to Supabase
        if all_processed_data:
            success = self.upload_to_supabase(all_processed_data)
            if success:
                print("Scraping completed successfully!")
            else:
                print("Scraping completed with errors during upload")
        else:
            print("No data to upload")

def main():
    """Main entry point"""
    try:
        scraper = CXAvailabilityScraper()
        scraper.run_scraper()
    except Exception as e:
        print(f"Fatal error: {e}")
        return 1
    return 0

if __name__ == "__main__":
    exit(main())
