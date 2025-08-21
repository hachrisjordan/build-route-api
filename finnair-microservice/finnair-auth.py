#!/usr/bin/env python3
"""
Finnair Authentication Script using undetected-chromedriver

This script handles:
1. Opening Finnair.com in non-headless mode for manual login
2. Saving authentication cookies from auth.finnair.com
3. Injecting saved cookies on subsequent visits to maintain login state
"""

import json
import os
import time
import sys
from pathlib import Path
from typing import Dict, List, Optional, Any

# Custom patch for Python 3.13+ compatibility with undetected-chromedriver
def patch_distutils():
    """Patch the missing distutils module for Python 3.13+"""
    try:
        # Try to import undetected_chromedriver normally first
        import undetected_chromedriver as uc
        return uc
    except ImportError as e:
        if "distutils" in str(e):
            print("⚠️  Python 3.13+ compatibility issue detected.")
            print("Applying custom patch for distutils...")
            
            # Create a mock distutils.version module
            import types
            mock_distutils = types.ModuleType('distutils')
            mock_distutils.version = types.ModuleType('distutils.version')
            
            # Create a simple LooseVersion class
            class LooseVersion:
                def __init__(self, version_string):
                    self.version_string = str(version_string)
                
                def __str__(self):
                    return self.version_string
                
                def __repr__(self):
                    return f"LooseVersion('{self.version_string}')"
                
                def __lt__(self, other):
                    if isinstance(other, LooseVersion):
                        return self.version_string < other.version_string
                    return self.version_string < str(other)
                
                def __le__(self, other):
                    return self < other or self == other
                
                def __eq__(self, other):
                    if isinstance(other, LooseVersion):
                        return self.version_string == other.version_string
                    return self.version_string == str(other)
                
                def __ne__(self, other):
                    return not self == other
                
                def __gt__(self, other):
                    return not self <= other
                
                def __ge__(self, other):
                    return not self < other
            
            mock_distutils.version.LooseVersion = LooseVersion
            
            # Inject the mock module into sys.modules
            sys.modules['distutils'] = mock_distutils
            sys.modules['distutils.version'] = mock_distutils.version
            
            print("✅ Custom patch applied successfully!")
            
            # Now try to import undetected_chromedriver again
            try:
                import undetected_chromedriver as uc
                return uc
            except ImportError as e2:
                print(f"❌ Still failed to import after patch: {e2}")
                print("Please install undetected-chromedriver manually:")
                print("pip install undetected-chromedriver")
                sys.exit(1)
        else:
            print(f"❌ Unexpected import error: {e}")
            print("Please install undetected-chromedriver:")
            print("pip install undetected-chromedriver")
            sys.exit(1)

# Apply the patch and import undetected_chromedriver
uc = patch_distutils()

# Import selenium components (these are required by undetected_chromedriver)
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, WebDriverException


class FinnairAuthManager:
    """Manages Finnair authentication and cookie persistence"""
    
    def __init__(self, cookies_file: str = "finnair_cookies.json"):
        self.cookies_file = Path(cookies_file)
        self.driver = None
        self.cookies_loaded = False
        
    def setup_driver(self, headless: bool = False):
        """Initialize undetected-chromedriver with optimal settings"""
        options = uc.ChromeOptions()
        
        if not headless:
            options.add_argument("--start-maximized")
        
        # Add common options for better compatibility
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-blink-features=AutomationControlled")
        
        # Initialize driver
        self.driver = uc.Chrome(options=options)
        
        # Execute script to remove webdriver property
        self.driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        
        # Install preload capture interceptor so we catch the very first requests
        try:
            self.install_preload_capture_interceptor()
        except Exception as e:
            print(f"⚠️  Failed to install preload capture interceptor: {e}")
        
        return self.driver

    def install_preload_capture_interceptor(self) -> None:
        """Install a pre-load script that captures REAL Authorization headers from XHR/fetch before any page scripts run."""
        try:
            preload_js = r"""
            (function() {
              if (window.__ayPreloadCaptureInstalled) return;
              window.__ayPreloadCaptureInstalled = true;
              try {
                window.capturedBearerTokens = window.capturedBearerTokens || [];
                const pushToken = (info) => {
                  try { window.capturedBearerTokens.push(info); } catch (e) {}
                };
                const matchUrl = (u) => (u && (u.includes('offerList') || u.includes('offers-prod')));
                // Hook XHR
                const origOpen = XMLHttpRequest.prototype.open;
                const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
                XMLHttpRequest.prototype.open = function(method, url) {
                  this.__ayIsOffer = matchUrl(url);
                  this.__ayUrl = url;
                  return origOpen.apply(this, arguments);
                };
                XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                  try {
                    if (this.__ayIsOffer && name && name.toLowerCase() === 'authorization' && value) {
                      const url = this.__ayUrl || this.responseURL || '';
                      pushToken({ url, token: value, method: 'XHR', timestamp: new Date().toISOString(), isRealToken: true });
                    }
                  } catch (e) {}
                  return origSetHeader.apply(this, arguments);
                };
                // Hook fetch
                const origFetch = window.fetch;
                window.fetch = function(input, init) {
                  try {
                    const url = (typeof input === 'string') ? input : (input && input.url) || '';
                    if (matchUrl(url)) {
                      // Read Authorization from init.headers
                      let auth = null;
                      if (init && init.headers) {
                        try {
                          const h = (init.headers instanceof Headers) ? init.headers : new Headers(init.headers);
                          auth = h.get('Authorization') || h.get('authorization');
                        } catch (e) {}
                      }
                      // Also read from Request object if provided
                      if (!auth && input && typeof input === 'object' && 'headers' in input && input.headers) {
                        try { auth = input.headers.get && input.headers.get('Authorization'); } catch (e) {}
                        if (!auth) { try { auth = input.headers.get && input.headers.get('authorization'); } catch (e) {} }
                      }
                      if (auth) {
                        pushToken({ url, token: auth, method: 'fetch', timestamp: new Date().toISOString(), isRealToken: true });
                      }
                    }
                  } catch (e) {}
                  return origFetch.apply(this, arguments);
                };
                // Hook Request constructor (some libs pass headers here)
                const OrigRequest = window.Request;
                window.Request = function(resource, options) {
                  try {
                    const req = new OrigRequest(resource, options);
                    try {
                      const url = req.url || '';
                      if (matchUrl(url)) {
                        let auth = null;
                        try { auth = req.headers && req.headers.get('Authorization'); } catch (e) {}
                        if (!auth) { try { auth = req.headers && req.headers.get('authorization'); } catch (e) {} }
                        if (auth) {
                          pushToken({ url, token: auth, method: 'Request', timestamp: new Date().toISOString(), isRealToken: true });
                        }
                      }
                    } catch (e) {}
                    return req;
                  } catch (e) {
                    return new OrigRequest(resource, options);
                  }
                };
                window.Request.prototype = OrigRequest.prototype;
                console.log('AY preload capture interceptor active');
              } catch (e) {
                console.error('AY preload capture failed', e);
              }
            })();
            """
            # Ensure the script is evaluated on every new document before any page scripts
            self.driver.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument', { 'source': preload_js })
            print('✅ Preload capture interceptor installed')
        except Exception as e:
            print(f"❌ Failed to install preload capture interceptor: {e}")

    def load_cookies(self) -> bool:
        """Load saved cookies from file"""
        if not self.cookies_file.exists():
            print(f"No cookies file found at {self.cookies_file}")
            return False
            
        try:
            with open(self.cookies_file, 'r') as f:
                cookies = json.load(f)
            
            if not cookies:
                print("Cookies file is empty")
                return False
                
            print(f"Loaded {len(cookies)} cookies from {self.cookies_file}")
            return True
            
        except (json.JSONDecodeError, IOError) as e:
            print(f"Error loading cookies: {e}")
            return False
    
    def inject_castgc_cookie(self):
        """Inject the specific CASTGC authentication cookie from .AUTH.FINNAIR.COM"""
        try:
            # Go directly to the target URL first to set the context
            target_url = "https://www.finnair.com/us-en/booking/flight-selection?json=%7B%22flights%22:%5B%7B%22origin%22:%22HEL%22,%22destination%22:%22ARN%22,%22departureDate%22:%222025-08-27%22%7D%5D,%22cabin%22:%22MIXED%22,%22adults%22:1,%22c15s%22:0,%22children%22:0,%22infants%22:0,%22isAward%22:true%7D"
            
            print("Navigating directly to target URL to set context...")
            self.driver.get(target_url)
            time.sleep(3)
            
            # Install error auto-refresh watcher
            self.install_error_auto_refresh(max_reloads=2)
            
            print(f"Current URL: {self.driver.current_url}")
            print(f"Page title: {self.driver.title}")
            
            # Inject all the authentication cookies with correct domain format
            auth_cookies = [
                {
                    'name': 'CASTGC',
                    'value': 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCIsImtpZCI6IjEwMDY4MDExLWJjN2QtNGJhNi1iMjhiLTViMjg5M2I2NzVlYyJ9.ZXlKNmFYQWlPaUpFUlVZaUxDSmhiR2NpT2lKa2FYSWlMQ0psYm1NaU9pSkJNVEk0UTBKRExVaFRNalUySWl3aVkzUjVJam9pU2xkVUlpd2lkSGx3SWpvaVNsZFVJaXdpYTJsa0lqb2lZekZtTXpSbE9EUXROV1poTVMwME5qSm1MV0kxTXpZdFlqUTVPR0k1TjJWbU0ySTNJbjAuLlF3OTFQbldzelFGS3VhUEVWZ2p4eGcuS1NXZ2oyV3JycnRQTk13eUhGVDlQampGZ3VLclhNRHVNOGotRlNSQ3dVWWNYMEdGd0UtRnFYY01HNnFqd25QcDRfRnBsbVgwR0pzU1VDaGI5WVBYckJpZzNHRjM5X0ZEWlFKMG9jOVFmX003dDlKdVM2OVdmWlZQMXR2a0lSdkEuWkEyMkVFZV9uYTRmbzFaWE1RRlY3Zw.veztKC9ozmo4KGNigDSMCCt4ce-W0q46GKEX7NIAGM9qUu3bvX8QXWWq-LVtRpe9sB5uTivvLqTyt645C60UEw',
                    'domain': '.finnair.com',
                    'path': '/cas'
                },
                {
                    'name': 'AWSALB',
                    'value': 'rbMHNmM8HJ3tVtvMHJC0kANZygtLR1d5CIBS4pRy9bEJllGfe/trXUJ++xysx5G3f6S+EyrChQHMpx/Ylz+mXzadw5gIpKspGRWlROX+kE7ACWv58CbhwUJ48uEg',
                    'domain': '.finnair.com',
                    'path': '/'
                },
                {
                    'name': 'AWSALBCORS', 
                    'value': 'rbMHNmM8HJ3tVtvMHJC0kANZygtLR1d5CIBS4pRy9bEJllGfe/trXUJ++xysx5G3f6S+EyrChQHMpx/Ylz+mXzadw5gIpKspGRWlROX+kE7ACWv58CbhwUJ48uEg',
                    'domain': '.finnair.com',
                    'path': '/'
                },
                {
                    'name': 'CASJSESSIONID',
                    'value': '84913EBA3DEA6371F23958B3F8BFF6E9',
                    'domain': '.finnair.com',
                    'path': '/cas'
                }
            ]
            
            # Inject each cookie
            for cookie in auth_cookies:
                try:
                    self.driver.add_cookie(cookie)
                    print(f"✅ {cookie['name']} cookie injected")
                except Exception as e:
                    print(f"❌ Failed to inject {cookie['name']}: {e}")
            
            print("✅ All authentication cookies injected")
            print("Cookies applied immediately - no refresh needed!")
            
            # Change the date to 7 days after today
            self.change_flight_date()
            
            # Set up XHR interception for offerList requests
            self.setup_xhr_interception()
            
            return True
            
        except Exception as e:
            print(f"❌ Error: {e}")
            return False
    
    def change_flight_date(self):
        """Change the flight date to 7 days after today"""
        try:
            from datetime import datetime, timedelta
            
            # Calculate date 7 days from today
            today = datetime.now()
            new_date = today + timedelta(days=7)
            new_date_str = new_date.strftime("%Y-%m-%d")
            
            print(f"Changing flight date to: {new_date_str}")
            
            # Execute JavaScript to update the date in the URL
            script = f"""
            const url = new URL(window.location.href);
            const params = new URLSearchParams(url.search);
            const jsonParam = params.get('json');
            
            if (jsonParam) {{
                try {{
                    const jsonData = JSON.parse(decodeURIComponent(jsonParam));
                    if (jsonData.flights && jsonData.flights.length > 0) {{
                        jsonData.flights[0].departureDate = '{new_date_str}';
                        const newJsonParam = encodeURIComponent(JSON.stringify(jsonData));
                        params.set('json', newJsonParam);
                        url.search = params.toString();
                        window.history.replaceState({{}}, '', url.toString());
                        return 'Date updated to ' + '{new_date_str}';
                    }}
                }} catch (e) {{
                    return 'Error updating date: ' + e.message;
                }}
            }}
            return 'Could not update date';
            """
            
            result = self.driver.execute_script(script)
            print(f"Date change result: {result}")
            
        except Exception as e:
            print(f"❌ Error changing flight date: {e}")
    
    def setup_xhr_interception(self):
        """Set up XHR interception for offerList requests and capture REAL Bearer tokens"""
        try:
            print("Setting up XHR interception for offerList requests...")
            
            # Execute JavaScript to intercept XHR requests and capture REAL Bearer tokens
            script = """
            // Store original XHR open method
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            const originalSend = XMLHttpRequest.prototype.send;
            
            // Preserve previously captured tokens if present
            window.capturedBearerTokens = window.capturedBearerTokens || [];
            
            // Intercept XHR requests
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                // Check if this is an offerList request
                if (url.includes('offerList') || url.includes('offers-prod')) {
                    this.__ayUrl = url;
                    console.log('🔍 Intercepted offerList request:', url);
                    
                    // Override setRequestHeader to capture authorization
                    this.setRequestHeader = function(name, value) {
                        if (name.toLowerCase() === 'authorization') {
                            console.log('🔑 CAPTURED REAL BEARER TOKEN:', value);
                            window.capturedBearerTokens.push({
                                url: this.__ayUrl || url,
                                token: value,
                                timestamp: new Date().toISOString(),
                                method: 'XHR',
                                isRealToken: true
                            });
                            // Don't block the original - let it go through
                            return originalSetRequestHeader.call(this, name, value);
                        }
                        return originalSetRequestHeader.call(this, name, value);
                    };
                }
                
                // Call original open method
                return originalOpen.call(this, method, url, ...args);
            };
            
            // Also intercept fetch requests
            const originalFetch = window.fetch;
            window.fetch = function(input, init={}) {
                try {
                    const url = (typeof input === 'string') ? input : (input && input.url) || '';
                    if (url.includes('offerList') || url.includes('offers-prod')) {
                        console.log('🔍 Intercepted fetch offerList request:', url);
                        
                        // Capture existing authorization header if present
                        let authHeader = null;
                        if (init && init.headers) {
                            try {
                                const h = (init.headers instanceof Headers) ? init.headers : new Headers(init.headers);
                                authHeader = h.get('Authorization') || h.get('authorization');
                            } catch (e) {}
                        }
                        if (!authHeader && input && typeof input === 'object' && input.headers) {
                            try { authHeader = input.headers.get && input.headers.get('Authorization'); } catch (e) {}
                            if (!authHeader) { try { authHeader = input.headers.get && input.headers.get('authorization'); } catch (e) {} }
                        }
                        if (authHeader) {
                            console.log('🔑 CAPTURED REAL BEARER TOKEN from fetch:', authHeader);
                            window.capturedBearerTokens.push({
                                url: url,
                                token: authHeader,
                                timestamp: new Date().toISOString(),
                                method: 'fetch',
                                isRealToken: true
                            });
                        }
                    }
                } catch (e) {
                    console.error('Error in fetch interception:', e);
                }
                return originalFetch(input, init);
            };
            
            console.log('✅ XHR and fetch interception set up for offerList requests');
            console.log('🔍 Will capture REAL Bearer tokens from Finnair API calls');
            return 'XHR interception active - REAL Bearer tokens will be captured';
            """
            
            result = self.driver.execute_script(script)
            print(f"XHR interception result: {result}")
            
            # Wait a bit for any initial requests to complete
            time.sleep(2)
            
            # Check if we captured any Bearer tokens
            self.check_captured_bearer_tokens()
            
        except Exception as e:
            print(f"❌ Error setting up XHR interception: {e}")
    
    def check_captured_bearer_tokens(self):
        """Check and display captured REAL Bearer tokens"""
        try:
            script = """
            if (window.capturedBearerTokens && window.capturedBearerTokens.length > 0) {
                return window.capturedBearerTokens;
            } else {
                return [];
            }
            """
            
            captured_tokens = self.driver.execute_script(script)
            
            if captured_tokens:
                print(f"\n🔑 CAPTURED {len(captured_tokens)} REAL BEARER TOKENS:")
                for i, token_info in enumerate(captured_tokens, 1):
                    print(f"  {i}. URL: {token_info.get('url', 'N/A')}")
                    print(f"     REAL TOKEN: {token_info.get('token', 'N/A')}")
                    print(f"     Method: {token_info.get('method', 'XHR')}")
                    print(f"     Time: {token_info.get('timestamp', 'N/A')}")
                    print()
            else:
                print("⚠️  No REAL Bearer tokens captured yet. Waiting for offerList requests...")
                
        except Exception as e:
            print(f"❌ Error checking captured Bearer tokens: {e}")
    
    def wait_for_bearer_token(self, timeout: int = 60) -> Optional[str]:
        """Wait for a REAL Bearer token to be captured from offerList requests"""
        print(f"⏳ Waiting up to {timeout} seconds for REAL Bearer token from Finnair API...")
        
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                script = """
                if (window.capturedBearerTokens && window.capturedBearerTokens.length > 0) {
                    // Return the first real token found
                    for (let token of window.capturedBearerTokens) {
                        if (token.isRealToken) {
                            return token.token;
                        }
                    }
                }
                return null;
                """
                
                token = self.driver.execute_script(script)
                if token:
                    print(f"✅ REAL Bearer token captured from Finnair API: {token[:50]}...")
                    return token
                
                time.sleep(2)
                
            except Exception as e:
                print(f"Error while waiting for token: {e}")
                time.sleep(2)
        
        print("❌ Timeout waiting for REAL Bearer token from Finnair API")
        return None
    
    def check_for_auth_cookies(self) -> bool:
        """Check if we have actual authentication cookies"""
        try:
            cookies = self.driver.get_cookies()
            
            # Look for common authentication cookie names
            auth_cookie_names = [
                'session', 'token', 'auth', 'login', 'user', 'member', 'customer',
                'access', 'jwt', 'bearer', 'identity', 'credential'
            ]
            
            auth_cookies = []
            for cookie in cookies:
                name = cookie.get('name', '').lower()
                domain = cookie.get('domain', '').lower()
                
                # Check if it's an auth cookie by name or domain
                if any(auth_name in name for auth_name in auth_cookie_names):
                    auth_cookies.append(cookie)
                elif 'auth' in domain or 'login' in domain:
                    auth_cookies.append(cookie)
            
            if auth_cookies:
                print(f"Found {len(auth_cookies)} potential authentication cookies:")
                for cookie in auth_cookies:
                    print(f"  - {cookie.get('name')} from {cookie.get('domain')}")
                return True
            else:
                print("No authentication cookies found. Available cookies:")
                for cookie in cookies:
                    print(f"  - {cookie.get('name')} from {cookie.get('domain')}")
                return False
                
        except Exception as e:
            print(f"Error checking for auth cookies: {e}")
            return False
    
    def save_cookies(self) -> bool:
        """Save current cookies to file"""
        if not self.driver:
            print("No driver instance available")
            return False
            
        try:
            # First navigate to auth.finnair.com to access those cookies
            print("Navigating to auth.finnair.com to capture authentication cookies...")
            self.driver.get("https://auth.finnair.com")
            time.sleep(3)
            
            # Get cookies from auth.finnair.com domain
            cookies = self.driver.get_cookies()
            
            # Filter for ONLY authentication cookies - exclude analytics, tracking, preferences
            auth_cookies = []
            excluded_patterns = [
                '_ga', '_gid', '_gcl', '_fbp', '_fbc',  # Google Analytics
                '_hj', '_uet', '_sfid',  # Hotjar, UET, Sitefinity
                'bm_sv', 'bm_sz', 'ak_bmsc',  # Akamai
                'RT', 'akaas_',  # Akamai
                'FINNAIR_COOKIE_', 'FinnairComLanguagePreference',  # Preferences
                'analytics-token', '_abck'  # Analytics and bot protection
            ]
            
            for cookie in cookies:
                name = cookie.get('name', '').lower()
                domain = cookie.get('domain', '').lower()
                
                # Skip cookies that match excluded patterns
                if any(pattern.lower() in name for pattern in excluded_patterns):
                    continue
                
                # Only include cookies that look like they could be authentication-related
                if any(auth_indicator in name for auth_indicator in [
                    'session', 'token', 'auth', 'login', 'user', 'member', 'customer',
                    'access', 'jwt', 'bearer', 'identity', 'credential', 'sid', 'id'
                ]):
                    auth_cookies.append(cookie)
                elif 'auth.finnair.com' in domain and name not in excluded_patterns:
                    # Include cookies from auth.finnair.com that aren't explicitly excluded
                    auth_cookies.append(cookie)
            
            if not auth_cookies:
                print("No authentication cookies found. Available cookies:")
                for cookie in cookies:
                    print(f"  - {cookie.get('name')} from {cookie.get('domain')}")
                return False
                
            # Save to file
            with open(self.cookies_file, 'w') as f:
                json.dump(auth_cookies, f, indent=2)
                
            print(f"Saved {len(auth_cookies)} authentication cookies to {self.cookies_file}")
            
            # Show what we captured
            print("Captured authentication cookies:")
            for cookie in auth_cookies:
                print(f"  - {cookie.get('name')} from {cookie.get('domain')}")
            
            return True
            
        except Exception as e:
            print(f"Error saving cookies: {e}")
            return False
    
    def inject_cookies(self) -> bool:
        """Inject saved cookies into the current session"""
        if not self.cookies_file.exists():
            print("No cookies file to inject")
            return False
            
        try:
            with open(self.cookies_file, 'r') as f:
                cookies = json.load(f)
            
            # First navigate to auth.finnair.com to set those cookies
            print("Setting cookies on auth.finnair.com...")
            self.driver.get("https://auth.finnair.com")
            time.sleep(2)
            
            # Inject each cookie
            for cookie in cookies:
                try:
                    # Remove problematic attributes that might cause issues
                    cookie_dict = {
                        'name': cookie['name'],
                        'value': cookie['value'],
                        'domain': cookie.get('domain', ''),
                        'path': cookie.get('path', '/'),
                    }
                    
                    # Only add secure and httpOnly if they exist and are boolean
                    if 'secure' in cookie:
                        cookie_dict['secure'] = cookie['secure']
                    if 'httpOnly' in cookie:
                        cookie_dict['httpOnly'] = cookie['httpOnly']
                    if 'expiry' in cookie:
                        cookie_dict['expiry'] = cookie['expiry']
                        
                    self.driver.add_cookie(cookie_dict)
                    
                except Exception as e:
                    print(f"Warning: Could not inject cookie {cookie.get('name', 'unknown')}: {e}")
                    continue
            
            print(f"Injected {len(cookies)} cookies")
            
            # Now navigate to main site to apply cookies
            print("Navigating to main site to apply cookies...")
            self.driver.get("https://www.finnair.com/en")
            time.sleep(2)
            
            return True
            
        except Exception as e:
            print(f"Error injecting cookies: {e}")
            return False
    
    def check_login_status(self) -> bool:
        """Check if user is currently logged in"""
        try:
            # Navigate to a page that requires authentication
            self.driver.get("https://www.finnair.com/en/account")
            time.sleep(3)
            
            # Look for login indicators
            current_url = self.driver.current_url
            if "login" in current_url.lower() or "signin" in current_url.lower():
                return False
                
            # Check for account-related elements
            try:
                account_elements = self.driver.find_elements(By.CSS_SELECTOR, 
                    "[data-testid*='account'], .account-info, [class*='account']")
                if account_elements:
                    return True
            except:
                pass
                
            # Check URL for account page
            if "account" in current_url.lower():
                return True
                
            return False
            
        except Exception as e:
            print(f"Error checking login status: {e}")
            return False
    
    def manual_login_flow(self):
        """Handle the manual login flow"""
        print("Starting manual login flow...")
        print("1. Opening Finnair.com...")
        
        # Open main site
        self.driver.get("https://www.finnair.com/en")
        time.sleep(3)
        
        # Try to click login button if available
        try:
            login_selectors = [
                "[data-testid='login-button']",
                ".login-button",
                "[class*='login']",
                "a[href*='login']",
                "button:contains('Login')",
                "button:contains('Sign in')"
            ]
            
            login_clicked = False
            for selector in login_selectors:
                try:
                    if selector.startswith("button:contains"):
                        # Handle text-based selector
                        buttons = self.driver.find_elements(By.TAG_NAME, "button")
                        for button in buttons:
                            if "login" in button.text.lower() or "sign in" in button.text.lower():
                                button.click()
                                login_clicked = True
                                break
                    else:
                        element = self.driver.find_element(By.CSS_SELECTOR, selector)
                        element.click()
                        login_clicked = True
                        break
                except:
                    continue
            
            if not login_clicked:
                print("Could not find login button automatically. Please navigate to login manually.")
            
        except Exception as e:
            print(f"Could not automatically navigate to login: {e}")
            print("Please navigate to the login page manually.")
        
        print("\n2. Please navigate to the login page and log in manually...")
        print("3. IMPORTANT: After logging in, navigate to your account page or dashboard")
        print("4. Wait a few seconds for all authentication cookies to be set")
        print("5. Press Enter when you have completed the login and are on a logged-in page...")
        
        input("Press Enter after logging in and navigating to a logged-in page...")
        
        # Wait a bit more for cookies to fully propagate
        print("6. Waiting for authentication cookies to propagate...")
        time.sleep(5)
        
        # Check for authentication cookies first
        print("7. Checking for authentication cookies...")
        if self.check_for_auth_cookies():
            print("✅ Authentication cookies detected!")
        else:
            print("⚠️  No authentication cookies found. The login might not have been successful.")
            print("Please make sure you're actually logged in before proceeding.")
        
        # Save cookies after manual login
        print("8. Saving all Finnair cookies...")
        if self.save_cookies():
            print("✅ Cookies saved successfully!")
        else:
            print("❌ Failed to save cookies")
            print("This might mean the login wasn't successful or cookies weren't set properly.")
            print("Try logging in again and make sure you're actually authenticated.")
    
    def auto_login_with_cookies(self) -> bool:
        """Attempt to login using the specific CASTGC authentication cookie"""
        print("Attempting auto-login with CASTGC authentication cookie...")
        
        # Inject the specific CASTGC cookie
        if not self.inject_castgc_cookie():
            return False
        
        # Wait for the real Bearer token to be captured
        print("Waiting for Finnair API to make offerList request and capture Bearer token...")
        bearer_token = self.wait_for_bearer_token()
        
        if bearer_token:
            print(f"🎯 SUCCESS! Captured REAL Bearer token: {bearer_token}")
            print("You can now use this token in your curl commands!")
            return True
        else:
            print("❌ Failed to capture Bearer token - API call may not have been made")
            return False
    
    def run(self, force_manual: bool = False):
        """Main execution flow"""
        try:
            # Setup driver (headless by default)
            self.driver = self.setup_driver(headless=True)
            
            # Try auto flow only in headless
            if not self.auto_login_with_cookies():
                print("❌ Auto-login or token capture failed in headless mode.")
                return
            
        except Exception as e:
            print(f"Error in main execution: {e}")
        finally:
            if self.driver:
                try:
                    self.driver.quit()
                except:
                    pass

    def install_preload_interceptor(self, bearer_token: str) -> None:
        """Install a pre-load script so XHR and fetch to offerList always carry Authorization."""
        try:
            # Safely embed token into JS string
            token_js = "Bearer " + bearer_token.replace("\\", "\\\\").replace("'", "\\'")
            preload_js = """
            // XHR
            (function() {
              const TOKEN = '%s';
              const matchUrl = (u) => (u && (u.includes('offerList') || u.includes('offers-prod')));
              // Hook XHR
              const origOpen = XMLHttpRequest.prototype.open;
              const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
              XMLHttpRequest.prototype.open = function(method, url) {
                this.__ayOfferList = matchUrl(url);
                return origOpen.apply(this, arguments);
              };
              XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                if (this.__ayOfferList && name.toLowerCase() === 'authorization') {
                  // drop original
                  return;
                }
                return origSetHeader.apply(this, arguments);
              };
              const origSend = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.send = function(body) {
                if (this.__ayOfferList) {
                  try { origSetHeader.call(this, 'Authorization', TOKEN); } catch (e) {}
                }
                return origSend.apply(this, arguments);
              };
              // Hook fetch
              const origFetch = window.fetch;
              window.fetch = function(input, init={}) {
                try {
                  const url = (typeof input === 'string') ? input : (input && input.url) || '';
                  if (matchUrl(url)) {
                    init = init || {};
                    init.headers = new Headers(init.headers || {});
                    init.headers.set('Authorization', TOKEN);
                  }
                } catch (e) {}
                return origFetch(input, init);
              };
              console.log('AY preload interceptor active');
            })();
            """ % token_js
            # Ensure Network domain is enabled then install preload
            self.driver.execute_cdp_cmd('Network.enable', {})
            self.driver.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument', { 'source': preload_js })
            print('✅ Preload interceptor installed')
        except Exception as e:
            print(f"❌ Failed to install preload interceptor: {e}")

    def direct_url_access(self, target_url: str) -> bool:
        """Directly access any Finnair URL with injected cookies, bypassing redirects"""
        try:
            print(f"🚀 Direct URL access to: {target_url}")
            
            # First navigate to the target URL to set the context
            self.driver.get(target_url)
            time.sleep(3)
            
            # Install error auto-refresh watcher
            self.install_error_auto_refresh(max_reloads=2)
            
            print(f"Initial page load - URL: {self.driver.current_url}")
            print(f"Page title: {self.driver.title}")
            
            # Inject all the authentication cookies
            auth_cookies = [
                {
                    'name': 'CASTGC',
                    'value': 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCIsImtpZCI6IjEwMDY4MDExLWJjN2QtNGJhNi1iMjhiLTViMjg5M2I2NzVlYyJ9.ZXlKNmFYQWlPaUpFUlVZaUxDSmhiR2NpT2lKa2FYSWlMQ0psYm1NaU9pSkJNVEk0UTBKRExVaFRNalUySWl3aVkzUjVJam9pU2xkVUlpd2lkSGx3SWpvaVNsZFVJaXdpYTJsa0lqb2lZekZtTXpSbE9EUXROV1poTVMwME5qSm1MV0kxTXpZdFlqUTVPR0k1TjJWbU0ySTNJbjAuLlF3OTFQbldzelFGS3VhUEVWZ2p4eGcuS1NXZ2oyV3JycnRQTk13eUhGVDlQampGZ3VLclhNRHVNOGotRlNSQ3dVWWNYMEdGd0UtRnFYY01HNnFqd25QcDRfRnBsbVgwR0pzU1VDaGI5WVBYckJpZzNHRjM5X0ZEWlFKMG9jOVFmX003dDlKdVM2OVdmWlZQMXR2a0lSdkEuWkEyMkVFZV9uYTRmbzFaWE1RRlY3Zw.veztKC9ozmo4KGNigDSMCCt4ce-W0q46GKEX7NIAGM9qUu3bvX8QXWWq-LVtRpe9sB5uTivvLqTyt645C60UEw',
                    'domain': '.finnair.com',
                    'path': '/cas'
                },
                {
                    'name': 'AWSALB',
                    'value': 'rbMHNmM8HJ3tVtvMHJC0kANZygtLR1d5CIBS4pRy9bEJllGfe/trXUJ++xysx5G3f6S+EyrChQHMpx/Ylz+mXzadw5gIpKspGRWlROX+kE7ACWv58CbhwUJ48uEg',
                    'domain': '.finnair.com',
                    'path': '/'
                },
                {
                    'name': 'AWSALBCORS', 
                    'value': 'rbMHNmM8HJ3tVtvMHJC0kANZygtLR1d5CIBS4pRy9bEJllGfe/trXUJ++xysx5G3f6S+EyrChQHMpx/Ylz+mXzadw5gIpKspGRWlROX+kE7ACWv58CbhwUJ48uEg',
                    'domain': '.finnair.com',
                    'path': '/'
                },
                {
                    'name': 'CASJSESSIONID',
                    'value': '84913EBA3DEA6371F23958B3F8BFF6E9',
                    'domain': '.finnair.com',
                    'path': '/cas'
                }
            ]
            
            # Inject each cookie
            for cookie in auth_cookies:
                try:
                    self.driver.add_cookie(cookie)
                    print(f"✅ {cookie['name']} cookie injected")
                except Exception as e:
                    print(f"❌ Failed to inject {cookie['name']}: {e}")
            
            print("✅ All authentication cookies injected")
            print("Cookies applied immediately - no refresh needed!")
            
            # Set up XHR interception for offerList requests
            self.setup_xhr_interception()
            
            # Wait for the real Bearer token to be captured
            print("Waiting for Finnair API to make offerList request and capture Bearer token...")
            bearer_token = self.wait_for_bearer_token()
            
            if bearer_token:
                print(f"🎯 SUCCESS! Captured REAL Bearer token: {bearer_token}")
                print("You can now use this token in your curl commands!")
                
                # Check if we're still on the target URL (not redirected)
                if target_url in self.driver.current_url or self.driver.current_url == target_url:
                    print("✅ Successfully accessed target URL without unwanted redirects!")
                    return True
                else:
                    print(f"⚠️  Page was redirected to: {self.driver.current_url}")
                    print("But we still captured the Bearer token!")
                    return True
            else:
                print("❌ Failed to capture Bearer token - API call may not have been made")
                return False
            
        except Exception as e:
            print(f"❌ Error in direct URL access: {e}")
            return False

    def install_error_auto_refresh(self, max_reloads: int = 2, match_text: str = "We couldn't fetch the flight details") -> None:
        """Inject a DOM watcher that reloads the page when a specific Finnair error message appears.
        Limits reloads to max_reloads to avoid infinite loops.
        """
        try:
            # Escape the match_text for JS string
            safe_text = match_text.replace("\\", "\\\\").replace("'", "\\'")
            script = f"""
            (function() {{
              try {{
                window.__ayReloads = window.__ayReloads || 0;
                window.__ayMaxReloads = {max_reloads};
                window.__ayErrorWatcherInstalled = window.__ayErrorWatcherInstalled || false;
                const MATCH = '{safe_text}'.toLowerCase();
                if (window.__ayErrorWatcherInstalled) return;
                window.__ayErrorWatcherInstalled = true;
                const shouldReload = () => {{
                  if (window.__ayReloads >= window.__ayMaxReloads) return false;
                  try {{
                    const txt = (document.body && document.body.innerText || '').toLowerCase();
                    return txt.includes(MATCH);
                  }} catch (e) {{ return false; }}
                }};
                const doReload = () => {{
                  if (!shouldReload()) return;
                  window.__ayReloads++;
                  console.log('AY auto-refresh: detected Finnair fetch error. Reloading...', window.__ayReloads);
                  setTimeout(() => {{ location.reload(); }}, 250);
                }};
                // Initial check and periodic timer as a fallback
                if (shouldReload()) doReload();
                window.__ayErrorInterval = window.setInterval(doReload, 1000);
                // MutationObserver for faster reaction
                try {{
                  const obs = new MutationObserver(() => doReload());
                  obs.observe(document.documentElement, {{ childList: true, subtree: true, characterData: true }});
                  window.__ayErrorObserver = obs;
                }} catch (e) {{}}
                console.log('AY error auto-refresh watcher installed');
              }} catch (e) {{ console.error('AY error auto-refresh install failed', e); }}
            }})();
            """
            self.driver.execute_script(script)
        except Exception as e:
            print(f"⚠️  Failed to install error auto-refresh: {e}")


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Finnair Authentication Manager")
    parser.add_argument("--force-manual", action="store_true", 
                       help="Force manual login even if cookies exist")
    parser.add_argument("--cookies-file", default="finnair_cookies.json",
                       help="Path to cookies file (default: finnair_cookies.json)")
    parser.add_argument("--direct-url", type=str,
                       help="Directly access a specific Finnair URL with injected cookies")
    
    args = parser.parse_args()
    
    # Create auth manager
    auth_manager = FinnairAuthManager(cookies_file=args.cookies_file)
    
    try:
        if args.direct_url:
            # Direct URL access mode (headless)
            print(f"🚀 Direct URL access mode for: {args.direct_url}")
            auth_manager.setup_driver(headless=True)
            success = auth_manager.direct_url_access(args.direct_url)
            
            if not success:
                print("❌ Direct URL access failed")
        else:
            # Normal authentication flow (headless)
            auth_manager.run(force_manual=False)
            
    except KeyboardInterrupt:
        print("\nScript interrupted by user")
    except Exception as e:
        print(f"Unexpected error: {e}")
    finally:
        if auth_manager.driver:
            try:
                auth_manager.driver.quit()
            except:
                pass


if __name__ == "__main__":
    main()
