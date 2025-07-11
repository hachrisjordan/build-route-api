#!/bin/sh

# Start American microservice
node american-microservice/american-service.js &

# Start Alaska microservice
node alaska-microservice/alaska-service.js &

# Start JetBlue microservice
node jetblue-microservice/jetblue-service.js &

# Start Finnair microservice
node finnair-microservice/finnair-service.js &

# Start United microservice
npx tsx united-microservice/united-service.ts &

# Start the script to fetch AA cookies
node scripts/fetch-aa-cookies.js &

# Start the main Next.js app (foreground)
npm start 

# Start Xvfb in the background
Xvfb :99 -screen 0 1920x1080x24 & 
export DISPLAY=:99