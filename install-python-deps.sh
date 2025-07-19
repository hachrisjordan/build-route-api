#!/bin/bash

# Install Python dependencies for the build-route-api project
echo "Installing Python dependencies..."

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "Python 3 is not installed. Installing..."
    if command -v apt-get &> /dev/null; then
        # Ubuntu/Debian
        sudo apt-get update
        sudo apt-get install -y python3 python3-pip
    elif command -v yum &> /dev/null; then
        # CentOS/RHEL
        sudo yum update -y
        sudo yum install -y python3 python3-pip
    else
        echo "Could not install Python 3. Please install it manually."
        exit 1
    fi
fi

# Install pip if not available
if ! command -v pip3 &> /dev/null; then
    echo "pip3 is not installed. Installing..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get install -y python3-pip
    elif command -v yum &> /dev/null; then
        sudo yum install -y python3-pip
    fi
fi

# Install Python dependencies
echo "Installing Python packages from requirements.txt..."
pip3 install --user -r requirements.txt

echo "Python dependencies installed successfully!"
echo "You can now run the FlightRadar API script." 