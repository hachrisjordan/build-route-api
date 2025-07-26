#!/bin/bash

# Exit on any error
set -e

echo "🚀 Starting deployment..."

# Load environment variables
if [ -f .env ]; then
    echo "📋 Loading environment variables..."
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "❌ .env file not found!"
    exit 1
fi

# Check required environment variables
required_vars=(
    "DOCKERHUB_USERNAME"
    "NEXT_PUBLIC_SUPABASE_URL"
    "SUPABASE_SERVICE_ROLE_KEY"
    "VALKEY_HOST"
    "VALKEY_PORT"
    "VALKEY_PASSWORD"
)

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Missing required environment variable: $var"
        exit 1
    fi
done

echo "✅ All required environment variables are set"

# Pull latest images
echo "📥 Pulling latest Docker images..."
docker-compose -f docker-compose.prod.yml pull

# Stop existing containers
echo "🛑 Stopping existing containers..."
docker-compose -f docker-compose.prod.yml down

# Remove old containers and networks (but keep volumes)
echo "🧹 Cleaning up old containers..."
docker-compose -f docker-compose.prod.yml down --remove-orphans

# Start services
echo "🚀 Starting services..."
docker-compose -f docker-compose.prod.yml up -d

# Wait for services to be ready
echo "⏳ Waiting for services to be ready..."
sleep 10

# Check if Redis is responding (hardcoded password)
echo "🔍 Checking Redis connection..."
if docker-compose -f docker-compose.prod.yml exec -T redis redis-cli -a "your_redis_password_here" ping | grep -q "PONG"; then
    echo "✅ Redis is responding"
else
    echo "❌ Redis is not responding"
    docker-compose -f docker-compose.prod.yml logs redis
    exit 1
fi

# Check if Valkey is responding
echo "🔍 Checking Valkey connection..."
if docker-compose -f docker-compose.prod.yml exec -T valkey redis-cli -a "$VALKEY_PASSWORD" ping | grep -q "PONG"; then
    echo "✅ Valkey is responding"
else
    echo "❌ Valkey is not responding"
    docker-compose -f docker-compose.prod.yml logs valkey
    exit 1
fi

# Check if API is healthy
echo "🔍 Checking API health..."
max_attempts=30
attempt=1
while [ $attempt -le $max_attempts ]; do
    if curl -f http://localhost:3000/api/health > /dev/null 2>&1; then
        echo "✅ API is healthy"
        break
    fi
    
    if [ $attempt -eq $max_attempts ]; then
        echo "❌ API health check failed after $max_attempts attempts"
        docker-compose -f docker-compose.prod.yml logs api
        exit 1
    fi
    
    echo "⏳ Waiting for API to be ready... (attempt $attempt/$max_attempts)"
    sleep 2
    attempt=$((attempt + 1))
done

# Show running containers
echo "📊 Running containers:"
docker-compose -f docker-compose.prod.yml ps

echo "🎉 Deployment completed successfully!"
echo "🌐 API is available at: http://localhost:3000"
echo "🔧 Redis is available at: localhost:6380"
echo "🔧 Valkey is available at: localhost:6379" 