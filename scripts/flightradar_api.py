#!/usr/bin/env python3
import cloudscraper
import json
from datetime import datetime, timezone, timedelta
import time
import sys
import hashlib
import os
import random
from typing import Optional, List

# Redis imports with graceful fallback
try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False
    print("Warning: redis package not available. Install with: pip install redis")
    print("Continuing without Redis caching...")

# No direct Supabase imports needed - tokens fetched via API

class FlightRadar24API:
    BASE_URL = "https://api.flightradar24.com/common/v1/flight/list.json"
    
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
        
        # Initialize token list from API
        self.available_tokens = self._load_tokens()
        self.current_token_index = 0
        
    def _init_redis_client(self):
        """Initialize Redis client with graceful error handling."""
        if not REDIS_AVAILABLE:
            return None
            
        try:
            # Get Redis configuration from environment variables with defaults
            # For local development, use localhost:6380 (host port)
            # For Docker containers, use redis:6379 (container port)
            redis_host = os.getenv('REDIS_HOST', 'localhost')
            
            # Handle Docker link format (tcp://ip:port) or direct port number
            redis_port_str = os.getenv('REDIS_PORT', '6380')
            if redis_port_str.startswith('tcp://'):
                # Extract port from Docker link format: tcp://172.17.0.2:6379
                redis_port = int(redis_port_str.split(':')[-1])
                redis_host = redis_port_str.split('://')[1].split(':')[0]
            else:
                redis_port = int(redis_port_str)
                
            redis_password = os.getenv('REDIS_PASSWORD')  # No default password
            
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
            print(f"[OK] Redis connected successfully to {redis_host}:{redis_port}")
            return client
            
        except Exception as e:
            print(f"[WARNING] Redis connection failed: {e}")
            print(f"[DEBUG] Redis config - Host: {redis_host}, Port: {redis_port}, Password: {'*' * len(redis_password) if redis_password else 'None'}")
            print("Continuing without Redis caching...")
            return None
    
    def _generate_cache_key(self, query: str, origin_iata: Optional[str] = None, destination_iata: Optional[str] = None) -> str:
        """Generate a unique cache key for the query parameters."""
        # Create a readable cache key
        key_parts = [query.upper()]
        if origin_iata:
            key_parts.append(origin_iata.upper())
        if destination_iata:
            key_parts.append(destination_iata.upper())
        
        return f"flightradar:{':'.join(key_parts)}"
    
    def _get_cached_results(self, cache_key: str) -> Optional[list]:
        """Retrieve cached results from Redis."""
        if not self.redis_client:
            return None
            
        try:
            cached_data = self.redis_client.get(cache_key)
            if cached_data:
                print(f"[OK] Found cached results for {cache_key}")
                return json.loads(cached_data)
            return None
        except Exception as e:
            print(f"[WARNING] Redis get error: {e}")
            return None
    
    def _cache_results(self, cache_key: str, results: list) -> bool:
        """Cache results in Redis with 24-hour TTL."""
        if not self.redis_client:
            return False
            
        try:
            # Cache for 24 hours (86400 seconds)
            ttl_seconds = 86400
            self.redis_client.setex(cache_key, ttl_seconds, json.dumps(results))
            print(f"[OK] Cached results for {cache_key} (TTL: 24h)")
            return True
        except Exception as e:
            print(f"[WARNING] Redis set error: {e}")
            return False

    def _load_tokens(self) -> List[str]:
        """Load available tokens from Next.js API."""
        try:
            # Get API URL from environment or use localhost default
            api_url = os.getenv('API_URL', 'http://localhost:3000')
            token_endpoint = f"{api_url}/api/tokens"
            
            print(f"🔄 Fetching tokens from API: {token_endpoint}")
            
            response = self.scraper.get(token_endpoint, headers={
                'Accept': 'application/json',
                'User-Agent': 'FlightRadar24-Scraper/1.0'
            })
            response.raise_for_status()
            
            data = response.json()
            if 'tokens' in data and data['tokens']:
                tokens = data['tokens']
                print(f"✅ Loaded {len(tokens)} tokens from API")
                return tokens
            else:
                raise Exception("No tokens returned from API")
                
        except Exception as e:
            print(f"Error: Failed to load tokens from API: {e}")
            raise Exception("Cannot proceed without valid tokens")

    def _get_next_token(self) -> str:
        """Get the next token in rotation."""
        if not self.available_tokens:
            raise Exception("No tokens available for rotation")
            
        token = self.available_tokens[self.current_token_index]
        self.current_token_index = (self.current_token_index + 1) % len(self.available_tokens)
        return token

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

    def get_flights(self, query, debug=True, origin_iata: Optional[str] = None, destination_iata: Optional[str] = None, stop_date: Optional[str] = None):
        """Fetch flights data for the given query.
        Optionally filter by origin and/or destination IATA code.
        Args:
            query (str): Flight number or search query.
            debug (bool): Enable debug output.
            origin_iata (Optional[str]): Origin airport IATA code to filter (case-insensitive).
            destination_iata (Optional[str]): Destination airport IATA code to filter (case-insensitive).
            start_date (Optional[str]): Start date in YYYY-MM-DD format. If provided, start scraping from this date instead of today.
        Returns:
            List[str]: List of unique flights in CSV format (flight_number,date,registration,origin_iata,destination_iata,ontime).
        """
        # Generate cache key
        cache_key = self._generate_cache_key(query, origin_iata, destination_iata)
        print(f"[DEBUG] Generated cache key: {cache_key}")
        
        # Try to get cached results first
        cached_results = self._get_cached_results(cache_key)
        if cached_results:
            print(f"[INFO] Returning {len(cached_results)} cached flights")
            return cached_results
        
        if not self.redis_client:
            print("[INFO] Redis not available, fetching fresh data...")
        else:
            print("[INFO] No cache found, fetching fresh data...")
        
        all_results = []
        
        # Track the earliest date found
        earliest_date = None
        
        # Track duplicate data to detect when to stop
        last_response_data = None
        duplicate_count = 0
        
        # Always start from today's timestamp
        current_timestamp = self._get_current_timestamp()
        
        if stop_date:
            try:
                # Parse stop_date for validation
                stop_datetime = datetime.strptime(stop_date, '%Y-%m-%d')
                print(f"🗓️  Latest date in database: {stop_date}")
                print(f"🎯 Starting from today, stopping when reaching {stop_date}")
                print(f"📅 Today's date: {self.today.strftime('%Y-%m-%d')}")
                print(f"📊 Target: Find flight data from today back to {stop_date}")
            except ValueError:
                print(f"❌ Invalid stop_date format: {stop_date}. Using 360-day limit instead.")
                stop_date = None
                print(f"📅 Today's date: {self.today.strftime('%Y-%m-%d')}")
                print(f"📊 Target: Find flight data going back 330-360 days from today")
        else:
            print(f"📅 Today's date: {self.today.strftime('%Y-%m-%d')}")
            print(f"📊 Target: Find flight data going back 330-360 days from today")
        
        # Counter for debug logging
        batch_count = 0
        
        # Retry counter for 402 errors
        retry_count = 0
        max_retries = 3
        
        # Continue fetching until we have about a year of data (330-360 days)
        # or we detect the same data multiple times
        while True:
            # Stop if current timestamp is more than 360 days ago
            days_ago = (self.today - datetime.fromtimestamp(current_timestamp).date()).days
            if days_ago > 360:
                print(f"Current timestamp is more than 360 days ago (>{days_ago} days). Stopping.")
                break
            batch_count += 1
            current_date = datetime.fromtimestamp(current_timestamp).strftime('%Y-%m-%d')
            days_back = (self.today - datetime.fromtimestamp(current_timestamp).date()).days
            
            print(f"\n==== Scraping Page {batch_count} ====")
            print(f"📅 Date: {current_date} ({days_back} days ago)")
            print(f"⏰ Timestamp: {current_timestamp}")
            print(f"🔍 Query: {query.upper()}")
            
            try:
                # Get next token in rotation
                current_token = self._get_next_token()
                print(f"🔑 Using token: {current_token[:20]}...")
                
                params = {
                    'query': query.upper(),
                    'fetchBy': 'flight',
                    'page': 1,  # Always use page 1
                    'pk': '',
                    'limit': 100,
                    'token': current_token,
                    'timestamp': current_timestamp
                }
                
                url = f"{self.BASE_URL}?{'&'.join(f'{k}={v}' for k, v in params.items())}"
                print(f"🌐 Requesting: {url}")
                
                response = self.scraper.get(url, headers=self.headers)
                response.raise_for_status()
                
                retry_count = 0  # Reset retry counter on success
                data = response.json()
                
                # Check if we got valid flight data
                if not data.get('result', {}).get('response', {}).get('data'):
                    print("❌ No flight data found in this page.")
                    current_timestamp -= 45 * 86400  # Go back 1 day (in seconds)
                    continue
                
                flights = data['result']['response']['data']
                print(f"✅ Found {len(flights)} flights on page {batch_count}")
                
                # Check if this is the last page (current < 90 means no more pages)
                item_current = data.get('result', {}).get('response', {}).get('item', {}).get('current', len(flights))
                is_last_page = item_current < 90
                
                if is_last_page:
                    print(f"📄 Last page detected (current={item_current} < 90). Will stop after processing this page.")
                
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
                        print(f"📅 New earliest date found: {earliest_date.strftime('%Y-%m-%d')}")
                
                # Add batch results to overall results (only if we have new data)
                new_flights = 0
                for result in batch_results:
                    if result not in all_results:
                        all_results.append(result)
                        new_flights += 1
                print(f"✅ Added {new_flights} new flights. Total so far: {len(all_results)}")

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
                
                # Check if this was the last page - if so, stop processing
                if is_last_page:
                    print(f"✅ Reached last page (current={item_current} < 90). Stopping.")
                    break
                
                # Check if we've reached the latest date from database or 360 days
                if earliest_date:
                    days_covered = (self.today - earliest_date).days
                    print(f"Currently covering {days_covered} days from {earliest_date.strftime('%Y-%m-%d')} to {self.today.strftime('%Y-%m-%d')}")
                    
                    # If we have a stop_date (latest date from database), stop when we reach it
                    if stop_date and earliest_date.strftime('%Y-%m-%d') <= stop_date:
                        print(f"✅ Reached existing data date {stop_date}. Stopping.")
                        break
                    # Otherwise, stop when we reach 360 days (default behavior)
                    elif not stop_date and days_covered > 360:
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
        print(f"📊 Pages scraped: {batch_count}")
        print(f"📈 Total flights found: {len(all_results)}")
        print(f"🔍 Unique flights: {len(unique_results)}")
        if earliest_date:
            print(f"📅 Date range: {earliest_date.strftime('%Y-%m-%d')} to {self.today.strftime('%Y-%m-%d')} ({(self.today - earliest_date).days} days)")
            print(f"🗓️  Latest date in database will be: {self.today.strftime('%Y-%m-%d')}")
        
        # Cache the results
        if unique_results:
            cache_success = self._cache_results(cache_key, unique_results)
            if cache_success:
                print(f"[DEBUG] Successfully cached {len(unique_results)} flights")
            else:
                print(f"[DEBUG] Failed to cache {len(unique_results)} flights")
        else:
            print("[DEBUG] No results to cache")
        
        return unique_results

def main():
    # Parse command line arguments with support for --stop-date
    flight_number = None
    origin_iata = None
    destination_iata = None
    stop_date = None
    
    # Parse arguments
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        
        if arg == '--stop-date':
            if i + 1 < len(sys.argv):
                stop_date = sys.argv[i + 1]
                i += 2
            else:
                print("Error: --stop-date requires a date value")
                sys.exit(1)
        elif flight_number is None:
            flight_number = arg
            i += 1
        elif origin_iata is None:
            origin_iata = arg
            i += 1
        elif destination_iata is None:
            destination_iata = arg
            i += 1
        else:
            print(f"Error: Unknown argument: {arg}")
            sys.exit(1)
    
    if not flight_number:
        print("Usage: python flightradar_api.py <flight_number> [origin_iata] [destination_iata] [--stop-date YYYY-MM-DD]")
        sys.exit(1)
    
    print(f"Searching for flight: {flight_number}")
    if origin_iata:
        print(f"Filtering by origin IATA: {origin_iata}")
    if destination_iata:
        print(f"Filtering by destination IATA: {destination_iata}")
    if stop_date:
        print(f"Stopping at date: {stop_date}")
    
    api = FlightRadar24API()
    results = api.get_flights(flight_number, origin_iata=origin_iata, destination_iata=destination_iata, stop_date=stop_date)
    
    # Print results one per line for easy parsing
    for result in results:
        print(result)

if __name__ == "__main__":
    main()