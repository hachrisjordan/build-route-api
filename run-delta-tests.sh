#!/bin/bash

# Delta Live Search Test Runner
# This script runs comprehensive tests to debug 429 rate limiting issues

set -e

echo "🚀 Delta Live Search Test Runner"
echo "================================"

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed or not in PATH"
    exit 1
fi

# Check if Delta microservice is running
echo "🔍 Checking if Delta microservice is running..."
if ! curl -s -f http://localhost:4005/delta -X POST -H "Content-Type: application/json" -d '{"from":"JFK","to":"LAX","depart":"2024-01-01","ADT":1}' > /dev/null 2>&1; then
    echo "❌ Delta microservice is not running on port 4005"
    echo "Please start it first:"
    echo "  cd delta-microservice && npm start"
    exit 1
fi

echo "✅ Delta microservice is running"

# Create results directory
mkdir -p delta-test-results
cd delta-test-results

echo ""
echo "🧪 Running Basic Delta Test..."
echo "=============================="
node ../test-delta-live-search.js

echo ""
echo "🔍 Running Advanced Rate Limit Debugger..."
echo "=========================================="
node ../delta-rate-limit-debugger.js

echo ""
echo "📊 Test Results Summary"
echo "======================="
echo "Results saved in: $(pwd)"
echo "Check the generated JSON reports for detailed analysis"

# List generated files
echo ""
echo "Generated files:"
ls -la *.json 2>/dev/null || echo "No JSON files found"

echo ""
echo "✅ All tests completed!"
