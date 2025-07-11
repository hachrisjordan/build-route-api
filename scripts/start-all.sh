#!/bin/sh

# Start Xvfb in the background and set DISPLAY first
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Now start all microservices
node alaska-microservice/alaska-service.js &
node jetblue-microservice/jetblue-service.js &
node finnair-microservice/finnair-service.js &
npx tsx united-microservice/united-service.ts &
# Start the main Next.js app (foreground)
npm start