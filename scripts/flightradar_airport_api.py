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
from concurrent.futures import ThreadPoolExecutor, as_completed

# Fix Windows console encoding for emoji support
if sys.platform == 'win32':
    try:
        # Try to set UTF-8 encoding for stdout/stderr
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        if hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        # Fallback: use ASCII-safe emoji replacements
        pass

# Redis imports with graceful fallback
try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False
    print("Warning: redis package not available. Install with: pip install redis")
    print("Continuing without Redis caching...")

# No direct Supabase imports needed - tokens fetched via API

# Airline code lists for filtering
AIRLINES = {
    'OW': ['AS', 'AA', 'BA', 'CX', 'FJ', 'AY', 'IB', 'JL', 'QF', 'QR', 'AT', 'RJ', 'UL', 'WY', 'MH'],  # Oneworld
    'SA': ['A3', 'AC', 'CA', 'AI', 'NZ', 'NH', 'NQ', 'EQ', 'OZ', 'OS', 'AV', 'SN', 'CM', 'OU', 'MS', 'ET', 'BR', 'LO', 'LH', 'CL', 'SQ', 'SA', 'LX', 'TP', 'TG', 'UA', 'TK'],  # Star Alliance
    'ST': ['AR', 'AM', 'UX', 'AF', 'CI', 'MU', 'DL', 'GA', 'KQ', 'KL', 'KE', 'ME', 'SV', 'SK', 'RO', 'VN', 'VS', 'MF'],  # SkyTeam
    'EY': ['EY'],
    'EK': ['EK'],
    'JX': ['JX'],
    'B6': ['B6'],
    'DE': ['DE'],
    'GF': ['GF'],
    'LY': ['LY'],
    'LA': ['LA'],
    'HA': ['HA'],
    'VA': ['VA'],
    'G3': ['G3'],
    'AD': ['AD']
}
ADDITIONAL_AIRLINES = ['QH','9G','EI', 'WS', 'VJ', '4Y', 'WK', 'EW', 'FI', 'AZ', 'HO', 'VA', 'EN', 'CZ', 'NK', 'F9', 'G4', 'MX', 'ZH', 'PR']

# Flatten all airline codes into a single set for quick lookup
ALL_VALID_AIRLINES = set()
for airline_list in AIRLINES.values():
    ALL_VALID_AIRLINES.update(airline_list)
ALL_VALID_AIRLINES.update(ADDITIONAL_AIRLINES)

def safe_print(message: str):
    """Print message safely, handling Unicode encoding errors on Windows."""
    try:
        print(message)
    except UnicodeEncodeError:
        # Replace common emojis with ASCII-safe alternatives
        replacements = {
            '🔄': '[REFRESH]',
            '✅': '[OK]',
            '⚠️': '[WARNING]',
            '❌': '[ERROR]',
            '📄': '[PAGE]',
            '📅': '[DATE]',
            '⏰': '[TIME]',
            '🔍': '[SEARCH]',
            '📊': '[STATS]'
        }
        safe_message = message
        for emoji, replacement in replacements.items():
            safe_message = safe_message.replace(emoji, replacement)
        print(safe_message)

class FlightRadar24AirportAPI:
    BASE_URL = "https://api.flightradar24.com/common/v1/airport.json"
    
    def __init__(self):
        self.scraper = cloudscraper.create_scraper()
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
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
    
    def _generate_cache_key(self, airport_code: str, mode: str, origin_iata: Optional[str] = None, destination_iata: Optional[str] = None) -> str:
        """Generate a unique cache key for the query parameters."""
        # Create a readable cache key
        key_parts = [airport_code.upper(), mode.lower()]
        if origin_iata:
            key_parts.append(origin_iata.upper())
        if destination_iata:
            key_parts.append(destination_iata.upper())
        
        return f"flightradar:airport:{':'.join(key_parts)}"
    
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
        """Load available tokens from Next.js API. Returns empty list if tokens are not available."""
        try:
            # Get API URL from environment or use localhost default
            api_url = os.getenv('API_URL', 'http://localhost:3000')
            token_endpoint = f"{api_url}/api/tokens"
            
            try:
                print(f"[INFO] Fetching tokens from API: {token_endpoint}")
            except UnicodeEncodeError:
                print(f"[INFO] Fetching tokens from API: {token_endpoint}")
            
            response = self.scraper.get(token_endpoint, headers={
                'Accept': 'application/json',
                'User-Agent': 'FlightRadar24-Scraper/1.0'
            }, timeout=5)
            response.raise_for_status()
            
            data = response.json()
            if 'tokens' in data and data['tokens']:
                tokens = data['tokens']
                try:
                    print(f"[OK] Loaded {len(tokens)} tokens from API")
                except UnicodeEncodeError:
                    print(f"[OK] Loaded {len(tokens)} tokens from API")
                return tokens
            else:
                print("[WARNING] No tokens returned from API")
                return []
                
        except Exception as e:
            print(f"[WARNING] Failed to load tokens from API: {e}")
            print("[INFO] Continuing without tokens (token parameter will be omitted from requests)")
            return []

    def _get_next_token(self) -> Optional[str]:
        """Get the next token in rotation. Returns None if no tokens are available."""
        if not self.available_tokens:
            return None
            
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

    def _is_valid_airline(self, flight_number: str) -> bool:
        """Check if flight number prefix matches any valid airline code."""
        if not flight_number or len(flight_number) < 2:
            return False
        
        prefix = flight_number[:2].upper()
        return prefix in ALL_VALID_AIRLINES

    def _is_valid_aircraft(self, aircraft_text: Optional[str]) -> bool:
        """Check aircraft text for capital F filtering. Skip if F appears anywhere except at start."""
        if not aircraft_text:
            return True  # Allow if no text
        
        # Allow if starts with F
        if aircraft_text.startswith('F'):
            return True
        
        # Skip if contains capital F anywhere else
        if 'F' in aircraft_text:
            return False
        
        return True

    def _fetch_page_with_retry(self, airport_code: str, mode: str, page: int, timestamp: int, max_retries: int = 3) -> Optional[dict]:
        """Fetch a single page with retry logic."""
        for attempt in range(max_retries):
            try:
                current_token = self._get_next_token()
                
                params = {
                    'code': airport_code.upper(),
                    'plugin': '',
                    'plugin-setting[schedule][mode]': mode,
                    'plugin-setting[schedule][timestamp]': timestamp,
                    'page': page,
                    'limit': 100,
                    'fleet': ''
                }
                
                # Only add token parameter if available
                if current_token:
                    params['token'] = current_token
                
                url = f"{self.BASE_URL}?{'&'.join(f'{k}={v}' for k, v in params.items())}"
                
                response = self.scraper.get(url, headers=self.headers, timeout=30)
                response.raise_for_status()
                
                data = response.json()
                return data
                
            except Exception as e:
                error_message = str(e)
                
                # Special handling for 402 Payment Required errors - rotate token
                if "402" in error_message or "Payment Required" in error_message:
                    if attempt < max_retries - 1:
                        wait_time = (attempt + 1) * 2  # Exponential backoff: 2s, 4s, 8s
                        safe_print(f"⚠️  402 Payment Required error on page {page} ({mode}). Retrying in {wait_time}s... (Attempt {attempt + 1}/{max_retries})")
                        time.sleep(wait_time)
                        continue
                    else:
                        safe_print(f"❌ Failed to fetch page {page} ({mode}) after {max_retries} attempts: 402 error")
                        return None
                
                # Handle 429 rate limit errors
                elif "429" in error_message or "Too Many Requests" in error_message:
                    if attempt < max_retries - 1:
                        wait_time = (attempt + 1) * 3  # Longer backoff for rate limits: 3s, 6s, 9s
                        safe_print(f"⚠️  Rate limit (429) on page {page} ({mode}). Waiting {wait_time}s... (Attempt {attempt + 1}/{max_retries})")
                        time.sleep(wait_time)
                        continue
                    else:
                        safe_print(f"❌ Failed to fetch page {page} ({mode}) after {max_retries} attempts: rate limit")
                        return None
                
                # Handle timeout and connection errors
                elif "timeout" in error_message.lower() or "Connection" in error_message or "timed out" in error_message.lower():
                    if attempt < max_retries - 1:
                        wait_time = (attempt + 1) * 2
                        safe_print(f"⚠️  Network error on page {page} ({mode}). Retrying in {wait_time}s... (Attempt {attempt + 1}/{max_retries})")
                        time.sleep(wait_time)
                        continue
                    else:
                        safe_print(f"❌ Failed to fetch page {page} ({mode}) after {max_retries} attempts: network error")
                        return None
                
                # For other errors, retry once more
                else:
                    if attempt < max_retries - 1:
                        wait_time = (attempt + 1) * 2
                        safe_print(f"⚠️  Error on page {page} ({mode}): {error_message[:100]}. Retrying in {wait_time}s... (Attempt {attempt + 1}/{max_retries})")
                        time.sleep(wait_time)
                        continue
                    else:
                        safe_print(f"❌ Failed to fetch page {page} ({mode}) after {max_retries} attempts: {error_message[:100]}")
                        return None
        
        return None

    def _fetch_airport_pages(self, airport_code: str, mode: str, timestamp: int) -> List[dict]:
        """Fetch all pages for a given airport, mode, and timestamp concurrently."""
        all_flights = []
        
        # First, fetch page 0 to get total pages
        safe_print(f"📄 Fetching page 0 for {airport_code} ({mode})...")
        page0_data = self._fetch_page_with_retry(airport_code, mode, 0, timestamp)
        
        if not page0_data:
            safe_print(f"❌ Failed to fetch initial page 0 for {mode}")
            return []
        
        # Extract flights from page 0
        try:
            schedule_data = page0_data['result']['response']['airport']['pluginData']['schedule'][mode]
            page0_flights = schedule_data.get('data', [])
            total_pages = schedule_data.get('page', {}).get('total', 0)
            
            safe_print(f"✅ Page 0: Found {len(page0_flights)} flights, total pages: {total_pages}")
            
            # Process page 0 flights
            for flight_item in page0_flights:
                if 'flight' in flight_item:
                    all_flights.append(flight_item['flight'])
            
            # If no additional pages, return early
            if total_pages <= 1:
                return all_flights
            
            # Fetch remaining pages concurrently (pages -1 to -[total] inclusive)
            pages_to_fetch = list(range(-1, -(total_pages + 1), -1))  # -1, -2, -3, ..., -total_pages
            safe_print(f"🔄 Fetching {len(pages_to_fetch)} additional pages concurrently...")
            
            # Add small stagger to avoid overwhelming the API
            with ThreadPoolExecutor(max_workers=min(20, len(pages_to_fetch))) as executor:
                # Submit all page requests with small delays
                future_to_page = {}
                for idx, page_num in enumerate(pages_to_fetch):
                    # Stagger requests slightly
                    if idx > 0:
                        time.sleep(0.1 + (idx % 10) * 0.05)  # 0.1s to 0.6s stagger
                    
                    future = executor.submit(self._fetch_page_with_retry, airport_code, mode, page_num, timestamp)
                    future_to_page[future] = page_num
                
                # Process completed requests as they arrive
                completed = 0
                for future in as_completed(future_to_page):
                    page_num = future_to_page[future]
                    completed += 1
                    try:
                        page_data = future.result()
                        if page_data:
                            try:
                                schedule_data = page_data['result']['response']['airport']['pluginData']['schedule'][mode]
                                page_flights = schedule_data.get('data', [])
                                
                                for flight_item in page_flights:
                                    if 'flight' in flight_item:
                                        all_flights.append(flight_item['flight'])
                                
                                safe_print(f"✅ Page {page_num} ({completed}/{len(pages_to_fetch)}): Found {len(page_flights)} flights")
                            except (KeyError, TypeError) as e:
                                safe_print(f"⚠️  Page {page_num}: Error parsing response: {e}")
                        else:
                            safe_print(f"⚠️  Page {page_num}: Failed to fetch (will continue with other pages)")
                    except Exception as e:
                        safe_print(f"⚠️  Page {page_num}: Exception: {e}")
            
            safe_print(f"✅ Completed fetching all pages for {mode}. Total flights: {len(all_flights)}")
            
        except (KeyError, TypeError) as e:
            safe_print(f"❌ Error parsing page 0 response: {e}")
            return []
        
        return all_flights

    def _process_airport_flights(self, flights: List[dict], airport_code: str, mode: str, origin_iata: Optional[str] = None, destination_iata: Optional[str] = None) -> List[str]:
        """Process flights from airport API response and return CSV format results."""
        results = []
        
        # Debug counters
        airline_filtered = 0
        aircraft_filtered = 0
        origin_filtered = 0
        destination_filtered = 0
        error_count = 0
        processed_count = 0
        missing_codes = 0
        sample_filtered_airlines = []  # Track first few filtered airlines for debugging
        
        for flight in flights:
            try:
                flight_number = flight['identification']['number']['default']
                
                # Filter by airline code (first 2 characters)
                if not self._is_valid_airline(flight_number):
                    airline_filtered += 1
                    if len(sample_filtered_airlines) < 5:
                        prefix = flight_number[:2].upper() if len(flight_number) >= 2 else flight_number
                        sample_filtered_airlines.append(prefix)
                    continue
                
                # Get aircraft info and filter
                # Handle case where aircraft might be None
                aircraft = flight.get('aircraft') or {}
                aircraft_model = aircraft.get('model') or {}
                aircraft_text = aircraft_model.get('text') if isinstance(aircraft_model, dict) else None
                
                if not self._is_valid_aircraft(aircraft_text):
                    aircraft_filtered += 1
                    continue
                
                scheduled_departure = flight['time']['scheduled']['departure']
                timezone_offset = flight['airport']['origin']['timezone']['offset']
                registration = aircraft.get('registration') if isinstance(aircraft, dict) else 'N/A'
                if not registration:
                    registration = 'N/A'
                
                # For arrivals: destination is the queried airport (doesn't have code in response)
                # For departures: origin is the queried airport (should have code, but handle missing case)
                if mode == 'arrivals':
                    origin_code_obj = flight['airport']['origin'].get('code') or {}
                    origin_code = origin_code_obj.get('iata') if isinstance(origin_code_obj, dict) else None
                    destination_code = airport_code.upper()  # Arrivals: destination is the queried airport
                    if not origin_code:
                        missing_codes += 1
                        continue
                else:  # departures
                    origin_code = airport_code.upper()  # Departures: origin is the queried airport
                    destination_code_obj = flight['airport']['destination'].get('code') or {}
                    destination_code = destination_code_obj.get('iata') if isinstance(destination_code_obj, dict) else None
                    if not destination_code:
                        missing_codes += 1
                        continue
                
                # Get flight status
                status = flight['status']['text']
                
                # Get scheduled arrival time
                scheduled_arrival = flight['time']['scheduled'].get('arrival')
                real_arrival = flight['time']['real'].get('arrival')
                # Cross-check: if no real arrival but status starts with "Landed", use eventTime as real arrival
                if not real_arrival and isinstance(status, str) and status.strip().startswith('Landed'):
                    event_utc = flight.get('status', {}).get('generic', {}).get('eventTime', {}).get('utc')
                    if event_utc:
                        real_arrival = event_utc
                
                # Handle diverted flights first
                if 'Diverted to' in status:
                    ontime = status  # Use the full status text which includes the diversion airport
                elif status == 'Canceled':
                    ontime = 'CANCELED'
                # Check if flight is canceled: scheduled arrival > 24h ago and no real arrival
                elif scheduled_arrival and not real_arrival:
                    current_time = self._get_current_timestamp()
                    hours_since_scheduled = (current_time - scheduled_arrival) / 3600
                    if hours_since_scheduled > 24:
                        ontime = 'CANCELED'
                    else:
                        ontime = 'N/A'
                # Calculate ontime if flight is not canceled and has real arrival time
                elif real_arrival and scheduled_arrival:
                    time_diff_minutes = int((real_arrival - scheduled_arrival) / 60)
                    ontime = str(time_diff_minutes)
                else:
                    ontime = 'N/A'

                # Guard: filter by origin_iata if provided
                if origin_iata and (not origin_code or origin_code.upper() != origin_iata.upper()):
                    origin_filtered += 1
                    continue
                # Guard: filter by destination_iata if provided
                if destination_iata and (not destination_code or destination_code.upper() != destination_iata.upper()):
                    destination_filtered += 1
                    continue

                date = self._format_flight_date(scheduled_departure, timezone_offset)
                results.append(f"{flight_number},{date},{registration},{origin_code},{destination_code},{ontime}")
                processed_count += 1
                
            except (KeyError, TypeError) as e:
                # Skip malformed flight entries
                error_count += 1
                if error_count <= 5:  # Only show first 5 errors
                    safe_print(f"⚠️  Skipping malformed flight: {str(e)[:100]}")
                continue
        
        # Print debug info
        if airline_filtered > 0 or aircraft_filtered > 0 or error_count > 0 or missing_codes > 0:
            debug_msg = f"🔍 Filter stats: {processed_count} processed, {airline_filtered} airline-filtered"
            if sample_filtered_airlines:
                debug_msg += f" (sample: {', '.join(sample_filtered_airlines)})"
            debug_msg += f", {aircraft_filtered} aircraft-filtered, {missing_codes} missing-codes, {origin_filtered} origin-filtered, {destination_filtered} destination-filtered, {error_count} errors"
            print(debug_msg)
        
        return results

    def get_airport_flights(self, airport_code: str, origin_iata: Optional[str] = None, destination_iata: Optional[str] = None, stop_date: Optional[str] = None):
        """Fetch flights data for the given airport code.
        Fetches both arrivals and departures for the current timestamp.
        All pages are fetched which contain historical flight data.
        Optionally filter by origin and/or destination IATA code.
        Args:
            airport_code (str): Airport IATA code (e.g., 'LHR').
            origin_iata (Optional[str]): Origin airport IATA code to filter (case-insensitive).
            destination_iata (Optional[str]): Destination airport IATA code to filter (case-insensitive).
            stop_date (Optional[str]): Not used - kept for API compatibility.
        Returns:
            List[str]: List of unique flights in CSV format (flight_number,date,registration,origin_iata,destination_iata,ontime).
        """
        all_results = []
        
        # Use current timestamp - pages contain historical data
        current_timestamp = self._get_current_timestamp()
        current_date = datetime.fromtimestamp(current_timestamp).strftime('%Y-%m-%d')
        
        safe_print(f"📅 Today's date: {self.today.strftime('%Y-%m-%d')}")
        safe_print(f"⏰ Timestamp: {current_timestamp}")
        safe_print(f"🔍 Airport: {airport_code.upper()}")
        safe_print(f"📊 Fetching all pages (containing historical flight data)")
        
        # Track the earliest and latest dates found
        earliest_date = None
        latest_date = None
        
        # Fetch both arrivals and departures
        for mode in ['arrivals', 'departures']:
            print(f"\n--- Processing {mode.upper()} ---")
            
            # Generate cache key for this mode
            cache_key = self._generate_cache_key(airport_code, mode, origin_iata, destination_iata)
            
            # Try to get cached results first
            cached_results = self._get_cached_results(cache_key)
            if cached_results:
                print(f"[INFO] Returning {len(cached_results)} cached flights for {mode}")
                all_results.extend(cached_results)
                # Track dates from cached results
                for result in cached_results:
                    parts = result.split(',')
                    if len(parts) >= 2:
                        try:
                            flight_date = self._parse_date(parts[1])
                            if not earliest_date or flight_date < earliest_date:
                                earliest_date = flight_date
                            if not latest_date or flight_date > latest_date:
                                latest_date = flight_date
                        except ValueError:
                            pass
                continue
            
            # Fetch all pages for this mode
            flights = self._fetch_airport_pages(airport_code, mode, current_timestamp)
            
            if not flights:
                safe_print(f"⚠️  No flights found for {mode} at timestamp {current_timestamp}")
                continue
            
            # Process flights
            batch_results = self._process_airport_flights(flights, airport_code, mode, origin_iata, destination_iata)
            safe_print(f"✅ Processed {len(batch_results)} valid flights from {len(flights)} total flights ({mode})")
            
            # Track dates and add results
            for result in batch_results:
                # Extract date from CSV result
                parts = result.split(',')
                if len(parts) >= 2:
                    try:
                        flight_date = self._parse_date(parts[1])
                        if not earliest_date or flight_date < earliest_date:
                            earliest_date = flight_date
                        if not latest_date or flight_date > latest_date:
                            latest_date = flight_date
                    except ValueError:
                        pass
                
                # Add to results if not duplicate
                if result not in all_results:
                    all_results.append(result)
            
            # Cache results for this mode
            if batch_results:
                self._cache_results(cache_key, batch_results)
        
        # Return unique results
        seen = set()
        unique_results = []
        for result in all_results:
            if result not in seen:
                seen.add(result)
                unique_results.append(result)
        
        print(f"\n==== Summary ====")
        print(f"📈 Total flights found: {len(all_results)}")
        safe_print(f"🔍 Unique flights: {len(unique_results)}")
        if earliest_date and latest_date:
            safe_print(f"📅 Date range: {earliest_date.strftime('%Y-%m-%d')} to {latest_date.strftime('%Y-%m-%d')} ({(latest_date - earliest_date).days + 1} days)")
        
        return unique_results

def main():
    # Parse command line arguments
    airport_code = None
    origin_iata = None
    destination_iata = None
    
    # Parse arguments
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        
        if airport_code is None:
            airport_code = arg
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
    
    if not airport_code:
        print("Usage: python flightradar_airport_api.py <airport_code> [origin_iata] [destination_iata]")
        sys.exit(1)
    
    print(f"Searching for airport: {airport_code.upper()}")
    if origin_iata:
        print(f"Filtering by origin IATA: {origin_iata}")
    if destination_iata:
        print(f"Filtering by destination IATA: {destination_iata}")
    
    api = FlightRadar24AirportAPI()
    results = api.get_airport_flights(airport_code, origin_iata=origin_iata, destination_iata=destination_iata)
    
    # Print results one per line for easy parsing
    for result in results:
        print(result)

if __name__ == "__main__":
    main()
