#!/usr/bin/env python3
"""
Test script to verify Finnair authentication setup
"""

def test_imports():
    """Test that all required modules can be imported"""
    try:
        import undetected_chromedriver as uc
        print("✅ undetected-chromedriver imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import undetected-chromedriver: {e}")
        return False
    
    try:
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        print("✅ Selenium modules imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import Selenium modules: {e}")
        return False
    
    try:
        import json
        import os
        import time
        from pathlib import Path
        print("✅ Standard library modules imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import standard library modules: {e}")
        return False
    
    return True

def test_chrome_detection():
    """Test if Chrome can be detected"""
    try:
        import undetected_chromedriver as uc
        
        # Try to get Chrome version
        chrome_version = uc.get_chrome_version()
        if chrome_version:
            print(f"✅ Chrome detected: version {chrome_version}")
            return True
        else:
            print("❌ Chrome not detected")
            return False
            
    except Exception as e:
        print(f"❌ Error detecting Chrome: {e}")
        return False

def test_file_permissions():
    """Test if we can create/write files in the current directory"""
    try:
        test_file = Path("test_permissions.tmp")
        
        # Test write
        with open(test_file, 'w') as f:
            f.write("test")
        
        # Test read
        with open(test_file, 'r') as f:
            content = f.read()
        
        # Cleanup
        test_file.unlink()
        
        if content == "test":
            print("✅ File permissions test passed")
            return True
        else:
            print("❌ File permissions test failed")
            return False
            
    except Exception as e:
        print(f"❌ File permissions test failed: {e}")
        return False

def main():
    """Run all tests"""
    print("🧪 Testing Finnair Authentication Setup...")
    print("=" * 50)
    
    tests = [
        ("Module Imports", test_imports),
        ("Chrome Detection", test_chrome_detection),
        ("File Permissions", test_file_permissions),
    ]
    
    passed = 0
    total = len(tests)
    
    for test_name, test_func in tests:
        print(f"\n🔍 Testing: {test_name}")
        if test_func():
            passed += 1
        else:
            print(f"   ❌ {test_name} failed")
    
    print("\n" + "=" * 50)
    print(f"📊 Test Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All tests passed! You're ready to use the Finnair authentication script.")
        print("\nNext steps:")
        print("1. Run: python finnair_auth.py")
        print("2. Follow the prompts to log in manually")
        print("3. Your cookies will be saved for future use")
    else:
        print("⚠️  Some tests failed. Please fix the issues before proceeding.")
        print("\nCommon solutions:")
        print("- Install missing Python packages: pip install -r requirements.txt")
        print("- Ensure Google Chrome is installed")
        print("- Check file permissions in the current directory")

if __name__ == "__main__":
    main()
