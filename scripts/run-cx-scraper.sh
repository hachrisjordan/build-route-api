#!/bin/bash
# CX Availability Scraper Runner Script
# This script ensures proper environment setup and logging for the CX scraper

# Set up logging
LOG_FILE="/app/cx_scraper.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TIMESTAMP] Starting CX Availability Scraper..." >> "$LOG_FILE"

# Ensure we're in the right directory
cd /app

# Check if virtual environment exists and activate it
if [ -d "/opt/venv" ]; then
    source /opt/venv/bin/activate
    echo "[$TIMESTAMP] Activated virtual environment" >> "$LOG_FILE"
else
    echo "[$TIMESTAMP] ERROR: Virtual environment not found at /opt/venv" >> "$LOG_FILE"
    exit 1
fi

# Check if the Python script exists
if [ ! -f "/app/cx_availability_scraper.py" ]; then
    echo "[$TIMESTAMP] ERROR: cx_availability_scraper.py not found" >> "$LOG_FILE"
    exit 1
fi

# Check if required environment variables are set
if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    echo "[$TIMESTAMP] ERROR: Required environment variables not set" >> "$LOG_FILE"
    echo "[$TIMESTAMP] NEXT_PUBLIC_SUPABASE_URL: ${NEXT_PUBLIC_SUPABASE_URL:+SET}" >> "$LOG_FILE"
    echo "[$TIMESTAMP] SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY:+SET}" >> "$LOG_FILE"
    exit 1
fi

echo "[$TIMESTAMP] Environment checks passed" >> "$LOG_FILE"
echo "[$TIMESTAMP] Starting CX scraper (will truncate cx table before processing)" >> "$LOG_FILE"

# Run the Python script with timeout (1 hour max)
timeout 3600 python /app/cx_availability_scraper.py >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
if [ $EXIT_CODE -eq 0 ]; then
    echo "[$TIMESTAMP] CX Availability Scraper completed successfully" >> "$LOG_FILE"
elif [ $EXIT_CODE -eq 124 ]; then
    echo "[$TIMESTAMP] ERROR: CX Availability Scraper timed out after 1 hour" >> "$LOG_FILE"
else
    echo "[$TIMESTAMP] ERROR: CX Availability Scraper failed with exit code $EXIT_CODE" >> "$LOG_FILE"
fi

# Log separator for readability
echo "[$TIMESTAMP] =============================================" >> "$LOG_FILE"

exit $EXIT_CODE
