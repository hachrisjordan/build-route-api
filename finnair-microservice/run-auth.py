#!/usr/bin/env python3
"""
Simple runner script for Finnair authentication
"""

from finnair_auth import FinnairAuthManager

if __name__ == "__main__":
    print("🚀 Starting Finnair Authentication Manager...")
    print("=" * 50)
    
    # Create auth manager
    auth_manager = FinnairAuthManager()
    
    try:
        # Run the authentication flow
        auth_manager.run()
    except KeyboardInterrupt:
        print("\n👋 Script interrupted by user")
    except Exception as e:
        print(f"❌ Error: {e}")
        print("Please check that Chrome is installed and undetected-chromedriver is working")
