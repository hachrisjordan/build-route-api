# United Airlines Microservice

This microservice fetches flight availability data from United Airlines using Arkalis browser automation.

## Setup

1. Ensure you have the required environment variables set:
   - `PROXY_HOST`
   - `PROXY_PORT` 
   - `PROXY_USERNAME`
   - `PROXY_PASSWORD`

2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Start the microservice:
```bash
node united-microservice/united-service.js
```

The service will run on port 4004.

### API Endpoint

**POST** `/united`

**Request Body:**
```json
{
  "from": "HAN",
  "to": "CVG", 
  "depart": "2025-07-17",
  "ADT": 1
}
```

**Response:**
Returns the raw United Airlines API response containing flight data.

## Integration

This microservice is called by the `/api/live-search-ua` endpoint which formats the response into the standardized itinerary format.

## Docker

The microservice is included in the docker-compose.yml and can be started with:

```bash
docker-compose up united-microservice
``` 