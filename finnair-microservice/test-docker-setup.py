#!/usr/bin/env python3
"""
Docker Environment Test Script
This script tests if the Docker environment is properly configured for the Finnair microservice.
"""

import os
import sys
import subprocess

def test_python_environment():
    """Test Python environment and packages"""
    print("🐍 Testing Python environment...")
    
    try:
        import undetected_chromedriver
        print("✅ undetected-chromedriver imported successfully")
    except ImportError as e:
        print(f"❌ undetected-chromedriver import failed: {e}")
        return False
    
    try:
        import selenium
        print("✅ selenium imported successfully")
    except ImportError as e:
        print(f"❌ selenium import failed: {e}")
        return False
    
    try:
        import supabase
        print("✅ supabase imported successfully")
    except ImportError as e:
        print(f"❌ supabase import failed: {e}")
        return False
    
    try:
        import dotenv
        print("✅ python-dotenv imported successfully")
    except ImportError as e:
        print(f"❌ python-dotenv import failed: {e}")
        return False
    
    return True

def test_chrome_installation():
    """Test Chrome and ChromeDriver installation"""
    print("\n🌐 Testing Chrome installation...")
    
    chrome_bin = os.getenv('CHROME_BIN', '/usr/bin/chromium-browser')
    chromedriver_path = os.getenv('CHROMEDRIVER_PATH', '/usr/bin/chromedriver')
    
    if os.path.exists(chrome_bin):
        print(f"✅ Chrome binary found at: {chrome_bin}")
    else:
        print(f"❌ Chrome binary not found at: {chrome_bin}")
        return False
    
    if os.path.exists(chromedriver_path):
        print(f"✅ ChromeDriver found at: {chromedriver_path}")
    else:
        print(f"❌ ChromeDriver not found at: {chromedriver_path}")
        return False
    
    return True

def test_display():
    """Test virtual display setup"""
    print("\n🖥️  Testing virtual display...")
    
    display = os.getenv('DISPLAY', ':99')
    print(f"Display set to: {display}")
    
    try:
        # Try to run xdpyinfo to check if display is working
        result = subprocess.run(['xdpyinfo', '-display', display], 
                              capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            print(f"✅ Display {display} is working")
            return True
        else:
            print(f"❌ Display {display} is not working")
            return False
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"⚠️  Could not test display: {e}")
        return False

def test_environment_variables():
    """Test environment variables"""
    print("\n🔧 Testing environment variables...")
    
    required_vars = [
        'CHROME_BIN',
        'CHROMEDRIVER_PATH', 
        'CHROME_DATA_DIR',
        'DISPLAY'
    ]
    
    all_good = True
    for var in required_vars:
        value = os.getenv(var)
        if value:
            print(f"✅ {var}: {value}")
        else:
            print(f"❌ {var}: Not set")
            all_good = False
    
    return all_good

def test_supabase_connection():
    """Test Supabase connection if credentials are available"""
    print("\n🗄️  Testing Supabase connection...")
    
    supabase_url = os.getenv('NEXT_PUBLIC_SUPABASE_URL')
    supabase_key = os.getenv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
    
    if not supabase_url or not supabase_key:
        print("⚠️  Supabase credentials not found - skipping connection test")
        return True
    
    try:
        from supabase import create_client
        client = create_client(supabase_url, supabase_key)
        
        # Try a simple query
        result = client.table('program').select('code').limit(1).execute()
        print("✅ Supabase connection successful")
        return True
    except Exception as e:
        print(f"❌ Supabase connection failed: {e}")
        return False

def main():
    """Run all tests"""
    print("🚀 Docker Environment Test for Finnair Microservice")
    print("=" * 50)
    
    tests = [
        test_python_environment,
        test_chrome_installation,
        test_display,
        test_environment_variables,
        test_supabase_connection
    ]
    
    passed = 0
    total = len(tests)
    
    for test in tests:
        try:
            if test():
                passed += 1
        except Exception as e:
            print(f"❌ Test {test.__name__} failed with exception: {e}")
    
    print("\n" + "=" * 50)
    print(f"📊 Test Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All tests passed! Docker environment is ready.")
        return 0
    else:
        print("⚠️  Some tests failed. Check the output above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())

