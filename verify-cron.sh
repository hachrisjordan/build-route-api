#!/bin/bash

# Verification script for Virgin Atlantic API cron job

echo "=== Virgin Atlantic API Cron Job Verification ==="
echo ""

# Check if cron service is running
if pgrep -x "cron" > /dev/null; then
    echo "✅ Cron service is running"
else
    echo "❌ Cron service is not running"
    echo "   Start it with: sudo service cron start"
fi

echo ""

# Show current cron jobs
echo "Current cron jobs:"
crontab -l 2>/dev/null | grep -E "(virginatlantic|seats-aero)" || echo "No Virgin Atlantic cron jobs found"

echo ""

# Test API manually
echo "Testing API manually..."
response=$(curl -s -w "%{http_code}" "http://localhost:3000/api/seats-aero-virginatlantic" -o /tmp/api_response.json)

if [ "$response" = "200" ]; then
    echo "✅ API is responding successfully (HTTP $response)"
    echo "   Response saved to /tmp/api_response.json"
else
    echo "❌ API test failed (HTTP $response)"
    echo "   Make sure your Next.js server is running on localhost:3000"
fi

echo ""

# Check if database table exists and has data
echo "Checking database for recent data..."
# This would require database access - you can add your own database check here

echo ""
echo "=== Setup Complete ==="
echo "The cron job will run every hour at the top of the hour."
echo "Check the database table 'virgin_atlantic_flights' for stored data." 