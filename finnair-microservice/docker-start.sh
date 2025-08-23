#!/bin/bash

# Docker startup script for Finnair microservice
# This script sets up the virtual display and runs the Python authentication script

set -e

echo "🚀 Starting Finnair microservice in Docker..."

# Check if we're in Docker
if [ -f /.dockerenv ]; then
    echo "✅ Running in Docker container"
else
    echo "⚠️  Not running in Docker container"
fi

# Set up virtual display
echo "🖥️  Setting up virtual display..."
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Wait for display to be ready
sleep 2

# Check if display is working
if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "✅ Virtual display is ready"
else
    echo "❌ Failed to set up virtual display"
    exit 1
fi

# Check Chrome installation
if [ -f "/usr/bin/chromium-browser" ]; then
    echo "✅ Chromium browser found"
else
    echo "❌ Chromium browser not found"
    exit 1
fi

if [ -f "/usr/bin/chromedriver" ]; then
    echo "✅ ChromeDriver found"
else
    echo "❌ ChromeDriver not found"
    exit 1
fi

# Check Python environment
echo "🐍 Checking Python environment..."
python3 --version
pip3 list | grep -E "(undetected-chromedriver|selenium|supabase)"

# Check if .env file exists
if [ -f "/app/.env" ]; then
    echo "✅ .env file found in /app"
elif [ -f "../.env" ]; then
    echo "✅ .env file found in parent directory"
else
    echo "⚠️  .env file not found - using environment variables"
fi

# Start the Python script
echo "🚀 Starting Finnair authentication script..."
cd /app/finnair-microservice

# First, test if the script runs without auto-restart
echo "🧪 Testing script execution..."
if python3 finnair-auth.py --no-restart --help >/dev/null 2>&1; then
    echo "✅ Script test successful, starting with auto-restart..."
    # Run with auto-restart enabled (every 100 minutes)
    python3 finnair-auth.py --restart-interval 100
else
    echo "❌ Script test failed, running without auto-restart for debugging..."
    python3 finnair-auth.py --no-restart
fi
