#!/bin/bash
# CX Scraper Setup Verification Script
# This script verifies that all components are properly configured for deployment

echo "=== CX Availability Scraper Setup Verification ==="
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0

# Function to check if a file exists
check_file() {
    local file="$1"
    local description="$2"
    
    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $description: $file"
    else
        echo -e "${RED}✗${NC} $description: $file (NOT FOUND)"
        ((ERRORS++))
    fi
}

# Function to check if a command exists
check_command() {
    local cmd="$1"
    local description="$2"
    
    if command -v "$cmd" >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $description: $cmd"
    else
        echo -e "${RED}✗${NC} $description: $cmd (NOT FOUND)"
        ((ERRORS++))
    fi
}

# Function to check environment variables
check_env_var() {
    local var="$1"
    local description="$2"
    
    if [ -n "${!var}" ]; then
        echo -e "${GREEN}✓${NC} $description: $var (SET)"
    else
        echo -e "${RED}✗${NC} $description: $var (NOT SET)"
        ((ERRORS++))
    fi
}

echo "1. Checking Python script and dependencies..."
check_file "/app/cx_availability_scraper.py" "Main Python script"
check_file "/app/requirements.txt" "Python requirements file"

echo ""
echo "2. Checking cron configuration..."
check_file "/app/docker/combined-crontab" "Combined crontab file"
check_file "/app/scripts/run-cx-scraper.sh" "CX scraper wrapper script"

echo ""
echo "3. Checking Docker configuration..."
check_file "/app/Dockerfile" "Dockerfile"
check_file "/app/docker-compose.yml" "Docker Compose file"

echo ""
echo "4. Checking Python virtual environment..."
check_file "/opt/venv/bin/python" "Python virtual environment"
check_file "/opt/venv/bin/activate" "Virtual environment activation script"

echo ""
echo "5. Checking required Python packages..."
if [ -f "/opt/venv/bin/python" ]; then
    echo "Checking installed Python packages..."
    /opt/venv/bin/python -c "
import sys
required_packages = ['supabase', 'requests', 'aiohttp', 'dotenv']
missing_packages = []

for package in required_packages:
    try:
        if package == 'dotenv':
            __import__('dotenv')
        else:
            __import__(package)
        print(f'✓ {package}')
    except ImportError:
        print(f'✗ {package} (NOT INSTALLED)')
        missing_packages.append(package)

if missing_packages:
    sys.exit(1)
    " 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} All required Python packages are installed"
    else
        echo -e "${RED}✗${NC} Some required Python packages are missing"
        ((ERRORS++))
    fi
else
    echo -e "${YELLOW}!${NC} Cannot check Python packages - virtual environment not found"
fi

echo ""
echo "6. Checking environment variables..."
check_env_var "NEXT_PUBLIC_SUPABASE_URL" "Supabase URL"
check_env_var "SUPABASE_SERVICE_ROLE_KEY" "Supabase Service Role Key"

echo ""
echo "7. Checking log file setup..."
check_file "/app/cx_scraper.log" "CX scraper log file"

echo ""
echo "8. Checking cron daemon..."
if pgrep -x "crond" > /dev/null; then
    echo -e "${GREEN}✓${NC} Cron daemon is running"
else
    echo -e "${YELLOW}!${NC} Cron daemon is not running (this is expected if not in container)"
fi

echo ""
echo "9. Testing Python script syntax..."
if [ -f "/app/cx_availability_scraper.py" ]; then
    if [ -f "/opt/venv/bin/python" ]; then
        /opt/venv/bin/python -m py_compile /app/cx_availability_scraper.py 2>/dev/null
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓${NC} Python script syntax is valid"
        else
            echo -e "${RED}✗${NC} Python script has syntax errors"
            ((ERRORS++))
        fi
    else
        echo -e "${YELLOW}!${NC} Cannot test Python syntax - virtual environment not found"
    fi
else
    echo -e "${RED}✗${NC} Cannot test Python syntax - script not found"
fi

echo ""
echo "10. Checking file permissions..."
if [ -x "/app/scripts/run-cx-scraper.sh" ]; then
    echo -e "${GREEN}✓${NC} CX scraper wrapper script is executable"
else
    echo -e "${RED}✗${NC} CX scraper wrapper script is not executable"
    ((ERRORS++))
fi

if [ -x "/app/cx_availability_scraper.py" ]; then
    echo -e "${GREEN}✓${NC} Python script is executable"
else
    echo -e "${YELLOW}!${NC} Python script is not executable (this might be OK)"
fi

echo ""
echo "=== Verification Summary ==="
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed! The CX scraper setup is ready for deployment.${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Build and deploy your Docker container"
    echo "2. Check the logs at /app/cx_scraper.log after the first hour"
    echo "3. Monitor the Supabase 'cx' table for new data"
    exit 0
else
    echo -e "${RED}✗ Found $ERRORS error(s). Please fix them before deployment.${NC}"
    exit 1
fi
