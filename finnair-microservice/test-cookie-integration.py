#!/usr/bin/env python3
"""
Test script to verify that the cookie integration with Supabase works correctly
"""

import os
import sys
from dotenv import load_dotenv

# Look for .env file in the parent directory (main project root)
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env_path = os.path.join(parent_dir, '.env')
load_dotenv(env_path)
print(f"✅ Environment variables loaded from: {env_path}")

try:
    from supabase import create_client, Client
    print("✅ Supabase client imported successfully")
except ImportError as e:
    print(f"❌ Failed to import Supabase client: {e}")
    print("Please install: pip install supabase")
    sys.exit(1)

def test_cookie_fetch():
    """Test fetching cookies from the database"""
    try:
        # Get Supabase configuration
        supabase_url = (
            os.getenv('SUPABASE_URL') or 
            os.getenv('NEXT_PUBLIC_SUPABASE_URL')
        )
        supabase_key = (
            os.getenv('SUPABASE_SERVICE_ROLE_KEY') or 
            os.getenv('SUPABASE_ANON_KEY') or
            os.getenv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
        )
        
        if not supabase_url or not supabase_key:
            print("❌ Missing Supabase configuration")
            return False
        
        print(f"🔗 Connecting to Supabase at: {supabase_url}")
        
        # Create client
        supabase = create_client(supabase_url, supabase_key)
        print("✅ Supabase client created successfully")
        
        # Test fetching cookies
        print("📖 Fetching AY cookies from database...")
        result = supabase.table('program').select('cookies').eq('code', 'AY').execute()
        
        if result.data and len(result.data) > 0:
            cookies_data = result.data[0].get('cookies')
            if cookies_data:
                print(f"✅ Successfully fetched {len(cookies_data)} cookies from database")
                print("Cookies found:")
                for cookie in cookies_data:
                    print(f"  - {cookie.get('name')} from {cookie.get('domain')}")
                return True
            else:
                print("⚠️  No cookies found in database for AY program")
                return False
        else:
            print("⚠️  No AY record found in program table")
            return False
            
    except Exception as e:
        print(f"❌ Cookie fetch test failed: {e}")
        return False

def test_cookie_update():
    """Test updating cookies in the database"""
    try:
        # Get Supabase configuration
        supabase_url = (
            os.getenv('SUPABASE_URL') or 
            os.getenv('NEXT_PUBLIC_SUPABASE_URL')
        )
        supabase_key = (
            os.getenv('SUPABASE_SERVICE_ROLE_KEY') or 
            os.getenv('SUPABASE_ANON_KEY') or
            os.getenv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
        )
        
        if not supabase_url or not supabase_key:
            print("❌ Missing Supabase configuration")
            return False
        
        # Create client
        supabase = create_client(supabase_url, supabase_key)
        
        # Test updating cookies with a test value
        print("🔄 Testing cookie update functionality...")
        test_cookies = [
            {
                "name": "TEST_COOKIE",
                "value": "test_value",
                "domain": ".finnair.com",
                "path": "/"
            }
        ]
        
        update_result = supabase.table('program').update({
            'cookies': test_cookies
        }).eq('code', 'AY').execute()
        
        if update_result.data:
            print("✅ Cookie update test successful")
            
            # Restore original cookies
            print("🔄 Restoring original cookies...")
            original_cookies = [
                {
                    "name": "CASTGC",
                    "value": "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCIsImtpZCI6ImQzNDVkYmIwLWNjOTItNDlmYS04Nzk3LWM4MDhkM2JmMjBlZiJ9.ZXlKNmFYQWlPaUpFUlVZaUxDSmhiR2NpT2lKa2FYSWlMQ0psYm1NaU9pSkJNVEk0UTBKRExVaFRNalUySWl3aVkzUjVJam9pU2xkVUlpd2lkSGx3SWpvaVNsZFVJaXdpYTJsa0lqb2lORGs0TW1Wa016Y3RORGxqWmkwME5EZG1MVGhqWkdJdE1HUmhPVGxoTW1GaVpEZGtJbjAuLmExNm42T1hGS1RRUURGekpHQmotRFEuR0lWTkEteFdOMTZ2X0RZTUV1Q0daNVJRY2dwc2loZm9zXy0zRjhCaS1JbExJTTJOQnlhcXBMb3BCSE1Sb3lhUnhjeTUycEc3bGNjb3EyMmRwVGxWRDNRS0ZuRFJoUlpyOXJPX2U2VUlHMkFHV1lsYXI1WmRCVHlIS3hnSE9kMkouNDNJdXpmSlBQQS1ZS0w4QkFIZ3d5QQ.oU4t5bMtQ3UJEeVae0-ATWSe4vH2A92mIcghVcuBoTnpDI4TvoL3qp45v2I1ZIfbsQbv9R-WlJLlmHcZKplabQ",
                    "domain": ".finnair.com",
                    "path": "/cas"
                },
                {
                    "name": "AWSALB",
                    "value": "8XYn5sNnSwO4PHg5V9/7vQ7AJCvjAAu1WrQTrs7matciPSCoMLQs0VB9vuqsGwC6XK4PZSUCRaQzDTO72cHlKPDNeJVneF+cHWmcwHcva9yZuaGx5HxqRjkXNLoY",
                    "domain": ".finnair.com",
                    "path": "/"
                },
                {
                    "name": "AWSALBCORS",
                    "value": "8XYn5sNnSwO4PHg5V9/7vQ7AJCvjAAu1WrQTrs7matciPSCoMLQs0VB9vuqsGwC6XK4PZSUCRaQzDTO72cHlKPDNeJVneF+cHWmcwHcva9yZuaGx5HxqRjkXNLoY",
                    "domain": ".finnair.com",
                    "path": "/"
                },
                {
                    "name": "CASJSESSIONID",
                    "value": "5ED0998E774DCA83CE0812EE5513B352",
                    "domain": ".finnair.com",
                    "path": "/cas"
                }
            ]
            
            restore_result = supabase.table('program').update({
                'cookies': original_cookies
            }).eq('code', 'AY').execute()
            
            if restore_result.data:
                print("✅ Original cookies restored")
                return True
            else:
                print("❌ Failed to restore original cookies")
                return False
        else:
            print("❌ Cookie update test failed")
            return False
            
    except Exception as e:
        print(f"❌ Cookie update test failed: {e}")
        return False

if __name__ == "__main__":
    print("🧪 Testing cookie integration with Supabase...")
    
    print("\n1️⃣ Testing cookie fetch...")
    fetch_success = test_cookie_fetch()
    
    print("\n2️⃣ Testing cookie update...")
    update_success = test_cookie_update()
    
    if fetch_success and update_success:
        print("\n🎉 All cookie integration tests passed!")
        print("The finnair-auth.py script can now use cookies from the database.")
    else:
        print("\n❌ Some tests failed.")
        if not fetch_success:
            print("  - Cookie fetch test failed")
        if not update_success:
            print("  - Cookie update test failed")

