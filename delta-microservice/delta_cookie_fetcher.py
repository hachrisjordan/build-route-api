import sys
import json
import time

# Requires: undetected-chromedriver
# pip install undetected-chromedriver

def main():
    try:
        import undetected_chromedriver as uc
    except Exception as e:
        print(json.dumps({"error": f"undetected-chromedriver not installed: {e}"}))
        sys.exit(1)

    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python delta_cookie_fetcher.py <url>"}))
        sys.exit(1)

    url = sys.argv[1]

    options = uc.ChromeOptions()
    # options.add_argument("--headless=new")  # Commented out to show browser window
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    # Align UA with your working call
    options.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36")

    driver = None
    try:
        driver = uc.Chrome(options=options)
        driver.set_page_load_timeout(60)
        driver.get(url)
        # Give Akamai/BM some time to set cookies (longer for visible mode)
        time.sleep(10)

        cookies = driver.get_cookies()
        # Build Cookie header string
        cookie_pairs = []
        for c in cookies:
            if c.get('name') and c.get('value'):
                cookie_pairs.append(f"{c['name']}={c['value']}")
        cookie_header = "; ".join(cookie_pairs)
        print(json.dumps({"cookie": cookie_header, "count": len(cookies)}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    finally:
        try:
            if driver:
                driver.quit()
        except Exception:
            pass

if __name__ == "__main__":
    main()


