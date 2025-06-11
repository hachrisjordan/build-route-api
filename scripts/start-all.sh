#!/bin/sh

# Start American microservice
node american-microservice/american-service.js &

# Start Alaska microservice
node alaska-microservice/alaska-service.js &

# Start JetBlue microservice
node jetblue-microservice/jetblue-service.js &

# Start the main Next.js app (foreground)
npm start 