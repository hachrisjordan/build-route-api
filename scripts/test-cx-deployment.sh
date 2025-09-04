#!/bin/bash
# CX Scraper Deployment Test Script
# This script tests the CX scraper deployment setup

echo "=== CX Scraper Deployment Test ==="
echo ""

# Function to run a test and report results
run_test() {
    local test_name="$1"
    local command="$2"
    
    echo "Testing: $test_name"
    if eval "$command"; then
        echo "✓ PASS: $test_name"
        echo ""
        return 0
    else
        echo "✗ FAIL: $test_name"
        echo ""
        return 1
    fi
}

FAILED_TESTS=0

# Test 1: Check if we can build the Docker image
echo "1. Testing Docker build process..."
if docker build -t cx-scraper-test . >/dev/null 2>&1; then
    echo "✓ PASS: Docker image builds successfully"
    echo ""
else
    echo "✗ FAIL: Docker image build failed"
    echo "Run 'docker build -t cx-scraper-test .' to see detailed errors"
    echo ""
    ((FAILED_TESTS++))
fi

# Test 2: Check if the crontab file is valid
echo "2. Testing crontab syntax..."
if crontab -T docker/combined-crontab 2>/dev/null; then
    echo "✓ PASS: Crontab syntax is valid"
    echo ""
else
    echo "✗ FAIL: Crontab syntax is invalid"
    echo "Check docker/combined-crontab for syntax errors"
    echo ""
    ((FAILED_TESTS++))
fi

# Test 3: Check Python script syntax
echo "3. Testing Python script syntax..."
if python3 -m py_compile cx_availability_scraper.py 2>/dev/null; then
    echo "✓ PASS: Python script syntax is valid"
    echo ""
else
    echo "✗ FAIL: Python script has syntax errors"
    echo "Check cx_availability_scraper.py for syntax errors"
    echo ""
    ((FAILED_TESTS++))
fi

# Test 4: Check if all required files exist
echo "4. Testing file existence..."
required_files=(
    "cx_availability_scraper.py"
    "docker/combined-crontab"
    "scripts/run-cx-scraper.sh"
    "scripts/verify-cx-setup.sh"
    "requirements.txt"
    "Dockerfile"
    "docker-compose.yml"
)

missing_files=0
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        echo "✗ Missing required file: $file"
        ((missing_files++))
    fi
done

if [ $missing_files -eq 0 ]; then
    echo "✓ PASS: All required files exist"
    echo ""
else
    echo "✗ FAIL: $missing_files required file(s) missing"
    echo ""
    ((FAILED_TESTS++))
fi

# Test 5: Check if scripts are executable
echo "5. Testing script permissions..."
if [ -x "scripts/run-cx-scraper.sh" ]; then
    echo "✓ PASS: CX scraper wrapper script is executable"
else
    echo "✗ FAIL: CX scraper wrapper script is not executable"
    echo "Run: chmod +x scripts/run-cx-scraper.sh"
    ((FAILED_TESTS++))
fi

if [ -x "scripts/verify-cx-setup.sh" ]; then
    echo "✓ PASS: Verification script is executable"
    echo ""
else
    echo "✗ FAIL: Verification script is not executable"
    echo "Run: chmod +x scripts/verify-cx-setup.sh"
    echo ""
    ((FAILED_TESTS++))
fi

# Test 6: Check if required Python packages are in requirements.txt
echo "6. Testing Python requirements..."
required_packages=("supabase" "python-dotenv" "requests" "aiohttp")
missing_packages=0

for package in "${required_packages[@]}"; do
    if ! grep -q "$package" requirements.txt; then
        echo "✗ Missing required package in requirements.txt: $package"
        ((missing_packages++))
    fi
done

if [ $missing_packages -eq 0 ]; then
    echo "✓ PASS: All required Python packages are in requirements.txt"
    echo ""
else
    echo "✗ FAIL: $missing_packages required package(s) missing from requirements.txt"
    echo ""
    ((FAILED_TESTS++))
fi

# Test 7: Check cron job configuration
echo "7. Testing cron job configuration..."
if grep -q "cx_availability_scraper\|run-cx-scraper" docker/combined-crontab; then
    echo "✓ PASS: CX scraper cron job is configured"
    echo ""
else
    echo "✗ FAIL: CX scraper cron job not found in crontab"
    echo ""
    ((FAILED_TESTS++))
fi

echo "=== Test Summary ==="
if [ $FAILED_TESTS -eq 0 ]; then
    echo "🎉 All tests passed! Your CX scraper is ready for deployment."
    echo ""
    echo "To deploy:"
    echo "1. Set your environment variables in .env file"
    echo "2. Run: docker-compose up --build -d"
    echo "3. Monitor logs: docker logs -f my-app-container"
    echo "4. Check CX scraper logs: docker exec my-app-container tail -f /app/cx_scraper.log"
    echo ""
    echo "The scraper will run every hour at :00 minutes."
    exit 0
else
    echo "❌ $FAILED_TESTS test(s) failed. Please fix the issues before deployment."
    exit 1
fi
