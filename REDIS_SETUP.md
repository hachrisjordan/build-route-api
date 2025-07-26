# Redis Setup and Configuration

## Problem Solved

The application was experiencing Redis connection errors during the build process and runtime due to:

1. **Build-time Redis connections**: Next.js was trying to connect to Redis at `127.0.0.1:6379` during build time when Redis wasn't available
2. **Max retries exceeded**: Redis client was hitting its retry limit (20 attempts) trying to connect to a non-existent Redis instance
3. **Hardcoded localhost connections**: Redis connections were hardcoded to localhost instead of using environment variables

## Solution Implemented

### 1. Updated Docker Compose Configuration

Added a dedicated Redis service to `docker-compose.yml`:

```yaml
# Application Redis (separate from valkey)
redis:
  image: redis:7-alpine
  ports:
    - "6380:6379"  # Using different port to avoid conflict with valkey
  command: ["redis-server", "--requirepass", "${REDIS_PASSWORD:-}"]
  volumes:
    - redis_data:/data
  restart: unless-stopped
```

### 2. Environment Variables

Added Redis environment variables to all services:

```yaml
environment:
  - REDIS_HOST=redis
  - REDIS_PORT=6379
  - REDIS_PASSWORD=${REDIS_PASSWORD:-}
```

### 3. Updated Redis Client Configuration

Modified Redis connections in API routes to:

- Use environment variables instead of hardcoded localhost
- Implement proper error handling
- Use lazy connections to prevent build-time connection attempts
- Reduce retry attempts to prevent excessive retries

### 4. Graceful Error Handling

Added try-catch blocks around Redis operations to prevent application crashes when Redis is unavailable.

## Environment Variables Required

Add these to your `.env` file:

```bash
# Redis Configuration (for application caching)
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# Valkey Configuration (for separate service - DO NOT CHANGE)
VALKEY_HOST=valkey
VALKEY_PORT=6379
VALKEY_PASSWORD=yourpassword
```

## Usage

1. **Start the services**:
   ```bash
   docker-compose up -d
   ```

2. **Access Redis**:
   - Application Redis: `localhost:6380` (port 6380 to avoid conflict with valkey)
   - Valkey: `localhost:6379` (unchanged)

3. **Monitor Redis**:
   ```bash
   # Connect to application Redis
   redis-cli -h localhost -p 6380 -a your_redis_password
   
   # Connect to valkey (unchanged)
   redis-cli -h localhost -p 6379 -a yourpassword
   ```

## Key Changes Made

### Files Modified:
- `docker-compose.yml` - Added Redis service and environment variables
- `src/app/api/filter-metadata/route.ts` - Updated Redis connection logic
- `src/app/api/build-itineraries/route.ts` - Updated Redis connection logic

### Benefits:
- ✅ No more build-time Redis connection errors
- ✅ Proper container networking
- ✅ Graceful handling of Redis unavailability
- ✅ Separate Redis instances for different purposes
- ✅ Environment-based configuration

## Troubleshooting

### If you still see Redis connection errors:

1. **Check if Redis container is running**:
   ```bash
   docker-compose ps
   ```

2. **Check Redis logs**:
   ```bash
   docker-compose logs redis
   ```

3. **Verify environment variables**:
   ```bash
   docker-compose exec api env | grep REDIS
   ```

4. **Test Redis connection manually**:
   ```bash
   docker-compose exec api redis-cli -h redis -p 6379 ping
   ```

### If you need to reset Redis data:

```bash
docker-compose down
docker volume rm build-route-api_redis_data
docker-compose up -d
``` 