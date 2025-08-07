#!/bin/bash

# Setup script for Virgin Atlantic API cron job

echo "Setting up cron job for Virgin Atlantic API..."

# Check if crontab exists
if ! crontab -l 2>/dev/null; then
    echo "No existing crontab found. Creating new one..."
fi

# Add the cron job
(crontab -l 2>/dev/null; echo "0 * * * * curl -X GET \"http://localhost:3000/api/seats-aero-virginatlantic\" > /dev/null 2>&1") | crontab -

echo "Cron job installed successfully!"
echo "The Virgin Atlantic API will now run every hour at the top of the hour."
echo ""
echo "To view current cron jobs: crontab -l"
echo "To edit cron jobs: crontab -e"
echo "To remove all cron jobs: crontab -r"
echo ""
echo "To test the API manually:"
echo "curl -X GET \"http://localhost:3000/api/seats-aero-virginatlantic\"" 