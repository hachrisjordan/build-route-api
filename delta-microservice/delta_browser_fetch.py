#!/usr/bin/env python3
import sys
import json
import time
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

def main():
    # Check if persistent mode is requested
    persistent_mode = '--persistent' in sys.argv
    
    if not persistent_mode:
        # Single request mode (legacy)
        if len(sys.argv) < 2:
            print(json.dumps({"error": "Missing URL parameter"}))
            sys.exit(1)
        
        url = sys.argv[1]
        process_single_request(url)
    else:
        # Persistent mode for browser pooling
        run_persistent_browser()

def process_single_request(url):
    try:
        # Read request data from stdin
        request_data = sys.stdin.read()
        if not request_data:
            print(json.dumps({"error": "No request data provided"}))
            sys.exit(1)
        
        request_json = json.loads(request_data)
        headers = request_json.get('headers', {})
        body = request_json.get('body', {})
        
        # Create undetected Chrome driver
        options = uc.ChromeOptions()
        options.add_argument('--start-minimized')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--disable-gpu')
        options.add_argument('--disable-web-security')
        options.add_argument('--disable-features=VizDisplayCompositor')
        options.add_argument('--disable-blink-features=AutomationControlled')
        options.add_argument('--disable-extensions')
        
        driver = uc.Chrome(options=options)
        
        try:
            # First navigate to Delta's main page to establish session
            driver.get("https://www.delta.com")
            time.sleep(3)
            
            # Execute the fetch request
            result = execute_fetch_request(driver, url, headers, body)
            print(json.dumps(result))
            
        except Exception as e:
            print(json.dumps({
                "error": f"Browser execution error: {str(e)}",
                "status": 500,
                "body": ""
            }))
        finally:
            try:
                driver.quit()
            except:
                pass
            
    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "status": 500,
            "body": ""
        }))

def run_persistent_browser():
    """Run browser in persistent mode, processing requests from stdin"""
    try:
        # Create undetected Chrome driver
        options = uc.ChromeOptions()
        options.add_argument('--start-minimized')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--disable-gpu')
        options.add_argument('--disable-web-security')
        options.add_argument('--disable-features=VizDisplayCompositor')
        options.add_argument('--disable-blink-features=AutomationControlled')
        options.add_argument('--disable-extensions')
        
        driver = uc.Chrome(options=options)
        
        # Navigate to Delta's main page once to establish session
        driver.get("https://www.delta.com")
        time.sleep(3)
        
        print("Browser ready for requests", file=sys.stderr)
        
        # Process requests from stdin
        for line in sys.stdin:
            try:
                line = line.strip()
                if not line:
                    continue
                
                request_data = json.loads(line)
                url = request_data.get('url')
                headers = request_data.get('headers', {})
                body = request_data.get('body', {})
                
                if not url:
                    continue
                
                # Execute the request
                result = execute_fetch_request(driver, url, headers, body)
                
                # Send response with markers
                print(f"RESPONSE_START{json.dumps(result)}RESPONSE_END")
                sys.stdout.flush()
                
            except Exception as e:
                error_result = {
                    "error": f"Request processing error: {str(e)}",
                    "status": 500,
                    "body": ""
                }
                print(f"RESPONSE_START{json.dumps(error_result)}RESPONSE_END")
                sys.stdout.flush()
                
    except Exception as e:
        print(f"Browser startup error: {str(e)}", file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            driver.quit()
        except:
            pass

def execute_fetch_request(driver, url, headers, body):
    """Execute a fetch request using the browser"""
    try:
        script = """
        return fetch(arguments[0], {
            method: 'POST',
            headers: arguments[1],
            body: JSON.stringify(arguments[2])
        }).then(response => {
            return response.text().then(text => {
                return {
                    status: response.status,
                    statusText: response.statusText,
                    headers: Object.fromEntries(response.headers.entries()),
                    body: text
                };
            });
        }).catch(error => {
            return {
                status: 500,
                statusText: 'Fetch Error',
                headers: {},
                body: 'Error: ' + error.message
            };
        });
        """
        
        result = driver.execute_script(script, url, headers, body)
        return result
        
    except Exception as e:
        return {
            "error": f"Fetch execution error: {str(e)}",
            "status": 500,
            "body": ""
        }

if __name__ == "__main__":
    main()


