#!/usr/bin/env python3
"""
Test script to verify Supabase connection and token update functionality
"""

import os
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
    exit(1)

def test_supabase_connection():
    """Test the Supabase connection and basic operations"""
    try:
        # Try both prefixed and non-prefixed environment variable names
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
            print("Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env file")
            print("   Or use NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY")
            return False
        
        print(f"🔗 Connecting to Supabase at: {supabase_url}")
        print(f"🔑 Using key: {supabase_key[:20]}...")
        
        # Create client
        supabase = create_client(supabase_url, supabase_key)
        print("✅ Supabase client created successfully")
        
        # Test reading current AY token
        print("📖 Reading current AY token from database...")
        result = supabase.table('program').select('token').eq('code', 'AY').execute()
        
        if result.data and len(result.data) > 0:
            current_token = result.data[0].get('token')
            print(f"✅ Current AY token: {current_token[:50]}..." if current_token else "No token found")
        else:
            print("⚠️  No AY record found in program table")
        
        # Test updating token (with a test value)
        print("🔄 Testing token update functionality...")
        test_token = "Bearer TEST_TOKEN_FOR_VERIFICATION"
        
        update_result = supabase.table('program').update({
            'token': test_token
        }).eq('code', 'AY').execute()
        
        if update_result.data:
            print("✅ Token update test successful")
            
            # Restore original token if we had one
            if current_token:
                print("🔄 Restoring original token...")
                restore_result = supabase.table('program').update({
                    'token': current_token
                }).eq('code', 'AY').execute()
                
                if restore_result.data:
                    print("✅ Original token restored")
                else:
                    print("❌ Failed to restore original token")
        else:
            print("❌ Token update test failed")
            return False
        
        print("✅ All Supabase tests passed!")
        return True
        
    except Exception as e:
        print(f"❌ Supabase test failed: {e}")
        return False

if __name__ == "__main__":
    print("🧪 Testing Supabase connection and functionality...")
    success = test_supabase_connection()
    
    if success:
        print("\n🎉 Supabase integration is working correctly!")
        print("You can now run the main Finnair auth script with automatic database updates.")
    else:
        print("\n❌ Supabase integration test failed.")
        print("Please check your configuration and try again.")
