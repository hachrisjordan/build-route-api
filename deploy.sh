#!/bin/bash

echo "🚀 Starting deployment..."

# Stop and remove old containers
echo "🛑 Stopping old containers..."
docker stop my-app-container redis-container valkey || true
docker rm my-app-container redis-container valkey || true

# Remove old images to force rebuild
echo "🧹 Cleaning old images..."
docker rmi binbinhihi/my-image-name:latest || true

# Build and start with docker-compose
echo "🔨 Building and starting services..."
docker-compose -f docker-compose.prod.yml up --build -d

echo "✅ Deployment complete!"
echo "📊 Services status:"
docker ps

echo "📝 Logs:"
echo "API logs: docker logs my-app-container -f"
echo "Redis logs: docker logs app-redis -f" 