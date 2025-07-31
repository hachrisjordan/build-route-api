#!/usr/bin/env python3
import cloudscraper
import json
from datetime import datetime, timezone, timedelta
import time
import sys
import hashlib
import os
from typing import Optional

# Redis imports with graceful fallback
try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False
    print("Warning: redis package not available. Install with: pip install redis")
    print("Continuing without Redis caching...")

class FlightRadar24API:
    BASE_URL = "https://api.flightradar24.com/common/v1/flight/list.json"
    TOKEN = "CvAG-3bJsFrhaQDaqCc9hC5bO3JWXUYMNkL7PCPgmXU"
    
    def __init__(self):
        self.scraper = cloudscraper.create_scraper()
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Origin': 'https://www.flightradar24.com',
            'Referer': 'https://www.flightradar24.com/',
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site'
        }
        
        # Save today's date for reference
        self.today = datetime.now().date()
        
        # Initialize Redis client
        self.redis_client = self._init_redis_client()
        
    def _init_redis_client(self):
        """Initialize Redis client with graceful error handling."""
        if not REDIS_AVAILABLE:
            return None
            
        try:
            # Get Redis configuration from environment variables with defaults
            redis_host = os.getenv('REDIS_HOST', 'localhost')
            redis_port = int(os.getenv('REDIS_PORT', 6379))
            redis_password = os.getenv('REDIS_PASSWORD')
            
            # Create Redis client
            client = redis.Redis(
                host=redis_host,
                port=redis_port,
                password=redis_password,
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=5,
                retry_on_timeout=True,
                health_check_interval=30
            )
            
            # Test connection
            client.ping()
            print(f"✅ Redis connected successfully to {redis_host}:{redis_port}")
            return client
            
        except Exception as e:
            print(f"⚠️  Redis connection failed: {e}")
            print("Continuing without Redis caching...")
            return None
    
    def _generate_cache_key(self, query: str, origin_iata: Optional[str] = None, destination_iata: Optional[str] = None) -> str:
        """Generate a unique cache key for the query parameters."""
        # Create a string representation of the query parameters
        params_str = f"{query.upper()}"
        if origin_iata:
            params_str += f":{origin_iata.upper()}"
        if destination_iata:
            params_str += f":{destination_iata.upper()}"
        
        # Create a hash of the parameters for a shorter, consistent key
        hash_object = hashlib.md5(params_str.encode())
        return f"flightradar:{hash_object.hexdigest()}"
    
    def _get_cached_results(self, cache_key: str) -> Optional[list]:
        """Retrieve cached results from Redis."""
        if not self.redis_client:
            return None
            
        try:
            cached_data = self.redis_client.get(cache_key)
            if cached_data:
                print(f"✅ Found cached results for {cache_key}")
                return json.loads(cached_data)
            return None
        except Exception as e:
            print(f"⚠️  Redis get error: {e}")
            return None
    
    def _cache_results(self, cache_key: str, results: list) -> bool:
        """Cache results in Redis with 24-hour TTL."""
        if not self.redis_client:
            return False
            
        try:
            # Cache for 24 hours (86400 seconds)
            ttl_seconds = 86400
            self.redis_client.setex(cache_key, ttl_seconds, json.dumps(results))
            print(f"✅ Cached results for {cache_key} (TTL: 24h)")
            return True
        except Exception as e:
            print(f"⚠️  Redis set error: {e}")
            return False

    def _get_current_timestamp(self):
        """Get current timestamp in seconds."""
        return int(time.time())
    
    def _parse_date(self, date_str):
        """Parse date string into datetime object"""
        return datetime.strptime(date_str, '%Y-%m-%d').date()
    
    def _date_to_timestamp(self, date_obj):
        """Convert datetime object to timestamp"""
        return int(datetime.combine(date_obj, datetime.min.time()).timestamp())

    def _format_flight_date(self, departure_timestamp, timezone_offset):
        """Convert timestamp to date string considering timezone offset."""
        local_time = datetime.fromtimestamp(departure_timestamp + timezone_offset, timezone.utc)
        return local_time.strftime('%Y-%m-%d')

    def get_flights(self, query, debug=True, origin_iata: Optional[str] = None, destination_iata: Optional[str] = None):
        """Fetch flights data for the given query.
        Optionally filter by origin and/or destination IATA code.
        Args:
            query (str): Flight number or search query.
            debug (bool): Enable debug output.
            origin_iata (Optional[str]): Origin airport IATA code to filter (case-insensitive).
            destination_iata (Optional[str]): Destination airport IATA code to filter (case-insensitive).
        Returns:
            List[str]: List of unique flights in CSV format (flight_number,date,registration,origin_iata,destination_iata,ontime).
        """
        # Generate cache key
        cache_key = self._generate_cache_key(query, origin_iata, destination_iata)
        
        # Try to get cached results first
        cached_results = self._get_cached_results(cache_key)
        if cached_results:
            print(f"📊 Returning {len(cached_results)} cached flights")
            return cached_results
        
        print("🔄 No cache found, fetching fresh data...")
        
        all_results = []
        
        # Track the earliest date found
        earliest_date = None
        
        # Track duplicate data to detect when to stop
        last_response_data = None
        duplicate_count = 0
        
        # Start with current timestamp
        current_timestamp = self._get_current_timestamp()
        
        # Counter for debug logging
        batch_count = 0
        
        # Retry counter for 402 errors
        retry_count = 0
        max_retries = 3
        
        print(f"Today's date: {self.today.strftime('%Y-%m-%d')}")
        print(f"Target: Find flight data going back 330-360 days from today")
        
        # Continue fetching until we have about a year of data (330-360 days)
        # or we detect the same data multiple times
        while True:
            # Stop if current timestamp is more than 360 days ago
            days_ago = (self.today - datetime.fromtimestamp(current_timestamp).date()).days
            if days_ago > 360:
                print(f"Current timestamp is more than 360 days ago (>{days_ago} days). Stopping.")
                break
            batch_count += 1
            print(f"\n==== Batch {batch_count} ====")
            print(f"Current timestamp: {current_timestamp} ({datetime.fromtimestamp(current_timestamp).strftime('%Y-%m-%d %H:%M:%S')})")
            
            try:
                params = {
                    'query': query.upper(),
                    'fetchBy': 'flight',
                    'page': 1,  # Always use page 1
                    'pk': '',
                    'limit': 100,
                    'token': self.TOKEN,
                    'timestamp': current_timestamp
                }
                
                url = f"{self.BASE_URL}?{'&'.join(f'{k}={v}' for k, v in params.items())}"
                print(f"Request URL: {url}")
                
                response = self.scraper.get(url, headers=self.headers)
                response.raise_for_status()
                
                retry_count = 0  # Reset retry counter on success
                data = response.json()
                
                # Check if we got valid flight data
                if not data.get('result', {}).get('response', {}).get('data'):
                    print("No flight data found in this batch.")
                    current_timestamp -= 45 * 86400  # Go back 1 day (in seconds)
                    continue
                
                flights = data['result']['response']['data']
                print(f"Found {len(flights)} flights in this batch")
                
                # Process the flights
                batch_results = []
                latest_flight_timestamp = None
                batch_earliest_date = None
                flight_dates = []
                
                for flight in flights:
                    try:
                        flight_number = flight['identification']['number']['default']
                        scheduled_departure = flight['time']['scheduled']['departure']
                        timezone_offset = flight['airport']['origin']['timezone']['offset']
                        registration = flight['aircraft']['registration'] or 'N/A'
                        origin_code = flight['airport']['origin']['code']['iata']
                        destination_code = flight['airport']['destination']['code']['iata']
                        
                        # Get flight status
                        status = flight['status']['text']
                        
                        # Handle diverted flights first
                        if 'Diverted to' in status:
                            ontime = status  # Use the full status text which includes the diversion airport
                        elif status == 'Canceled':
                            ontime = 'CANCELED'
                        # Calculate ontime if flight is not canceled and has real arrival time
                        elif flight['time']['real']['arrival']:
                            scheduled_arrival = flight['time']['scheduled']['arrival']
                            real_arrival = flight['time']['real']['arrival']
                            time_diff_minutes = int((real_arrival - scheduled_arrival) / 60)
                            ontime = str(time_diff_minutes)
                        else:
                            ontime = 'N/A'

                        # Guard: filter by origin_iata if provided
                        if origin_iata and (not origin_code or origin_code.upper() != origin_iata.upper()):
                            continue
                        # Guard: filter by destination_iata if provided
                        if destination_iata and (not destination_code or destination_code.upper() != destination_iata.upper()):
                            continue

                        date = self._format_flight_date(scheduled_departure, timezone_offset)
                        flight_date = self._parse_date(date)
                        flight_dates.append(date)
                        batch_results.append(f"{flight_number},{date},{registration},{origin_code},{destination_code},{ontime}")
                        
                        # Track earliest flight date in this batch
                        if not batch_earliest_date or flight_date < batch_earliest_date:
                            batch_earliest_date = flight_date
                        
                        # Track latest flight date to set next timestamp
                        if not latest_flight_timestamp or scheduled_departure < latest_flight_timestamp:
                            latest_flight_timestamp = scheduled_departure
                    except (KeyError, TypeError) as e:
                        # Skip malformed flight entries
                        print(f"Skipping malformed flight data: {str(e)}")
                        continue
                
                # Skip if no valid flight dates were found
                if not flight_dates:
                    print("No valid flight dates found in this batch.")
                    current_timestamp -= 45 * 86400  # Go back 45 days
                    continue
                
                # Print unique dates found in this batch
                unique_dates = sorted(set(flight_dates))
                print(f"Date range in this batch: {unique_dates[0]} to {unique_dates[-1]} ({len(unique_dates)} unique dates)")
                
                # Update overall date tracking
                if batch_earliest_date:
                    if not earliest_date or batch_earliest_date < earliest_date:
                        earliest_date = batch_earliest_date
                
                # Add batch results to overall results (only if we have new data)
                new_flights = 0
                for result in batch_results:
                    if result not in all_results:
                        all_results.append(result)
                        new_flights += 1
                print(f"Added {new_flights} new flights. Total so far: {len(all_results)}")

                if new_flights > 0:
                    # Update latest date for next timestamp calculation
                    if latest_flight_timestamp:
                        # Go 1 day earlier than the latest flight we found
                        next_timestamp = latest_flight_timestamp - 86400
                        print(f"Next timestamp based on oldest flight: {datetime.fromtimestamp(next_timestamp).strftime('%Y-%m-%d')}")
                        current_timestamp = next_timestamp
                    else:
                        # Fallback: go 30 days earlier from current timestamp
                        current_timestamp -= 30 * 86400
                        print(f"No flight timestamp found, jumping back 30 days to: {datetime.fromtimestamp(current_timestamp).strftime('%Y-%m-%d')}")
                else:
                    # All flights were duplicates, go back 45 days
                    current_timestamp -= 45 * 86400
                    print(f"All flights in this batch are duplicates. Jumping back 45 days to: {datetime.fromtimestamp(current_timestamp).strftime('%Y-%m-%d')}")
                
                # Check if we've reached more than 360 days
                if earliest_date:
                    days_covered = (self.today - earliest_date).days
                    print(f"Currently covering {days_covered} days from {earliest_date.strftime('%Y-%m-%d')} to {self.today.strftime('%Y-%m-%d')}")
                    if days_covered > 360:
                        print(f"Reached target of more than 360 days of data ({days_covered} days). Stopping.")
                        break
                
                # Allow a short break between requests to be respectful
                time.sleep(0.5)
                
            except Exception as e:
                error_message = str(e)
                print(f"Error encountered: {error_message}")
                
                # Special handling for 402 Payment Required errors
                if "402 Client Error: Payment Required" in error_message and retry_count < max_retries:
                    retry_count += 1
                    wait_time = retry_count * 2  # Exponential backoff
                    print(f"402 Payment Required error. Retrying in {wait_time} seconds... (Attempt {retry_count}/{max_retries})")
                    time.sleep(wait_time)
                    continue  # Retry with the same timestamp
                
                # For other errors or after max retries, go back 30 days
                current_timestamp -= 30 * 86400  # Go back 30 days
                print(f"Going back 30 days after error to: {datetime.fromtimestamp(current_timestamp).strftime('%Y-%m-%d')}")
                time.sleep(2)  # Wait longer after an error
                continue
        
        # Return unique results
        seen = set()
        unique_results = []
        for result in all_results:
            if result not in seen:
                seen.add(result)
                unique_results.append(result)
        
        print(f"\n==== Summary ====")
        print(f"Total flights found: {len(all_results)}")
        print(f"Unique flights: {len(unique_results)}")
        if earliest_date:
            print(f"Date range: {earliest_date.strftime('%Y-%m-%d')} to {self.today.strftime('%Y-%m-%d')} ({(self.today - earliest_date).days} days)")
        
        # Cache the results
        if unique_results:
            self._cache_results(cache_key, unique_results)
        
        return unique_results

def main():
    # Accept 1, 2, or 3 arguments: flight_number [origin_iata] [destination_iata]
    if len(sys.argv) < 2 or len(sys.argv) > 4:
        print("Usage: python flightradar_api.py <flight_number> [origin_iata] [destination_iata]")
        sys.exit(1)
    
    flight_number = sys.argv[1]
    origin_iata = sys.argv[2] if len(sys.argv) > 2 else None
    destination_iata = sys.argv[3] if len(sys.argv) > 3 else None
    print(f"Searching for flight: {flight_number}")
    if origin_iata:
        print(f"Filtering by origin IATA: {origin_iata}")
    if destination_iata:
        print(f"Filtering by destination IATA: {destination_iata}")
    api = FlightRadar24API()
    results = api.get_flights(flight_number, origin_iata=origin_iata, destination_iata=destination_iata)
    
    # Print results one per line for easy parsing
    for result in results:
        print(result)

if __name__ == "__main__":
    main()