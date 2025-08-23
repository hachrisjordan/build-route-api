#!/usr/bin/env python3
"""
Simple test script to verify basic functionality in Docker
"""

import os
import sys
import time

def main():
    print("🧪 Simple test script starting...")
    
    # Test basic imports
    try:
        import undetected_chromedriver
        print("✅ undetected-chromedriver imported")
    except ImportError as e:
        print(f"❌ undetected_chromedriver import failed: {e}")
        return 1
    
    try:
        import selenium
        print("✅ selenium imported")
    except ImportError as e:
        print(f"❌ selenium import failed: {e}")
        return 1
    
    try:
        import supabase
        print("✅ supabase imported")
    except ImportError as e:
        print(f"❌ supabase import failed: {e}")
        return 1
    
    # Test environment variables
    print(f"🌐 CHROME_BIN: {os.getenv('CHROME_BIN', 'Not set')}")
    print(f"🚗 CHROMEDRIVER_PATH: {os.getenv('CHROMEDRIVER_PATH', 'Not set')}")
    print(f"📁 CHROME_DATA_DIR: {os.getenv('CHROME_DATA_DIR', 'Not set')}")
    print(f"🖥️  DISPLAY: {os.getenv('DISPLAY', 'Not set')}")
    
    # Test file access
    cookies_file = "/app/finnair_cookies.json"
    if os.path.exists(cookies_file):
        print(f"✅ Cookies file found: {cookies_file}")
        print(f"   Size: {os.path.getsize(cookies_file)} bytes")
    else:
        print(f"❌ Cookies file not found: {cookies_file}")
    
    # Test Chrome binary
    chrome_bin = os.getenv('CHROME_BIN', '/usr/bin/chromium-browser')
    if os.path.exists(chrome_bin):
        print(f"✅ Chrome binary found: {chrome_bin}")
    else:
        print(f"❌ Chrome binary not found: {chrome_bin}")
    
    # Test ChromeDriver
    chromedriver = os.getenv('CHROMEDRIVER_PATH', '/usr/bin/chromedriver')
    if os.path.exists(chromedriver):
        print(f"✅ ChromeDriver found: {chromedriver}")
    else:
        print(f"❌ ChromeDriver not found: {chromedriver}")
    
    print("🧪 Basic tests completed successfully!")
    print("⏳ Waiting 10 seconds to simulate script execution...")
    time.sleep(10)
    print("✅ Test script finished!")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())

