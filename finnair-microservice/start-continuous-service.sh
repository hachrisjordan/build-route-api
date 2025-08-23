#!/bin/bash

# Finnair Continuous Service Launcher
# This script starts the Finnair authentication service that runs continuously
# and automatically restarts every 100 minutes to maintain fresh tokens.

set -e

echo "🚀 Starting Finnair Continuous Service..."
echo "📋 Service will automatically restart every 100 minutes"
echo "⏹️  Press Ctrl+C to stop the service"
echo ""

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 is not installed or not in PATH"
    exit 1
fi

# Check if we're in the right directory
if [ ! -f "finnair-auth.py" ]; then
    echo "❌ finnair-auth.py not found. Please run this script from the finnair-microservice directory."
    exit 1
fi

# Check if .env file exists in parent directory
if [ ! -f "../.env" ]; then
    echo "⚠️  .env file not found in parent directory. Please ensure it exists with Supabase configuration."
    echo "   You can run setup.sh to create it."
fi

echo "✅ Starting service..."
echo ""

# Start the continuous service
# The script will handle its own restarts every 100 minutes
python3 finnair-auth.py

echo ""
echo "�� Service stopped."
