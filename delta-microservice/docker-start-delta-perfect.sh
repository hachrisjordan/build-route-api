#!/bin/bash

# Docker startup script for Delta Perfect Service (curl_cffi)
# This script sets up the environment and runs the perfect Delta service

set -e

echo "🚀 Starting Delta Perfect Service in Docker..."

# Check if we're in Docker
if [ -f /.dockerenv ]; then
    echo "✅ Running in Docker container"
else
    echo "⚠️  Not running in Docker container"
fi

# Check Python environment
echo "🐍 Checking Python environment..."
python3 --version
pip3 list | grep -E "(curl_cffi|flask)"

# Check if curl_cffi is available
if python3 -c "import curl_cffi" 2>/dev/null; then
    echo "✅ curl_cffi is available"
else
    echo "❌ curl_cffi is not available - installing..."
    pip3 install curl_cffi flask
fi

# Check if the perfect service file exists
if [ -f "/app/delta-curl-cffi-perfect.py" ]; then
    echo "✅ Perfect service file found"
else
    echo "❌ Perfect service file not found at /app/delta-curl-cffi-perfect.py"
    exit 1
fi

# Make sure the script is executable
chmod +x /app/delta-curl-cffi-perfect.py

# Start the perfect Delta service
echo "🏆 Starting Perfect Delta curl_cffi Service..."
echo "🎯 Target: 100% Success Rate"
echo "🎲 Using 31 random open source strategies"
echo "🌐 Service will run on http://0.0.0.0:4009"

cd /app
exec python3 delta-curl-cffi-perfect.py
