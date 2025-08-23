#!/bin/bash

echo "🚀 Setting up Finnair Microservice with Automatic Database Updates"
echo "================================================================"

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3.7+ first."
    exit 1
fi

echo "✅ Python 3 found: $(python3 --version)"

# Check if pip is installed
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 is not installed. Please install pip3 first."
    exit 1
fi

echo "✅ pip3 found: $(pip3 --version)"

# Install Python dependencies
echo "📦 Installing Python dependencies..."
pip3 install -r requirements.txt

if [ $? -eq 0 ]; then
    echo "✅ Dependencies installed successfully"
else
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Create .env file if it doesn't exist
PARENT_DIR="$(dirname "$(dirname "$(readlink -f "$0")")")"
ENV_FILE="$PARENT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "🔧 Creating .env file in main project directory..."
    cat > "$ENV_FILE" << EOF
# Supabase Configuration (using Next.js naming convention)
NEXT_PUBLIC_SUPABASE_URL=https://dbaixrvzmfwhhbgyoebt.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here

# Alternative Supabase Configuration (if you prefer)
# SUPABASE_URL=https://dbaixrvzmfwhhbgyoebt.supabase.co
# SUPABASE_ANON_KEY=your_anon_key_here
# SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Finnair Configuration
FINNAIR_COOKIES_FILE=finnair_cookies.json
EOF
    echo "✅ .env file created at: $ENV_FILE"
    echo "⚠️  Please edit .env file with your actual Supabase credentials"
    echo "   The script will automatically use NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY"
else
    echo "ℹ️  .env file already exists at: $ENV_FILE"
fi

# Test Supabase connection
echo "🧪 Testing Supabase connection..."
python3 test-supabase-connection.py

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Setup completed successfully!"
    echo ""
    echo "Next steps:"
    echo "1. Edit .env file with your Supabase credentials"
    echo "2. Run: python3 finnair-auth.py"
    echo "3. The script will automatically capture tokens and update the database"
else
    echo ""
    echo "⚠️  Setup completed but Supabase connection test failed"
    echo "Please check your .env file configuration and try again"
fi

echo ""
echo "📚 For more information, see README.md"
