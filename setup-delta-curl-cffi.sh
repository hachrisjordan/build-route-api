#!/bin/bash

# Setup script for Delta curl_cffi service

echo "🚀 Setting up Delta curl_cffi Service"
echo "====================================="

# Check if Python 3 is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed or not in PATH"
    exit 1
fi

echo "✅ Python 3 found: $(python3 --version)"

# Create virtual environment if it doesn't exist
if [ ! -d "delta-curl-cffi-env" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv delta-curl-cffi-env
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source delta-curl-cffi-env/bin/activate

# Install requirements
echo "📥 Installing requirements..."
pip install -r requirements-delta.txt

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start the curl_cffi service:"
echo "  source delta-curl-cffi-env/bin/activate"
echo "  python delta-curl-cffi-service.py"
echo ""
echo "To test both services:"
echo "  node test-curl-cffi-delta.js"
echo ""
echo "The curl_cffi service will run on port 4006"
echo "The original service should run on port 4005"
