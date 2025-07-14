#!/bin/sh

# Clean up any stale Xvfb lock file
rm -f /tmp/.X99-lock

# Start Xvfb in the background and set DISPLAY first
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Start x11vnc in the background for VNC access (default password: 'vncpassword')
x11vnc -display :99 -forever -shared -passwd vncpassword -rfbport 5900 -bg

# Start noVNC (websockify) in the background
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &

# Now start all microservices
node alaska-microservice/alaska-service.js &
node jetblue-microservice/jetblue-service.js &
node finnair-microservice/finnair-service.js &
npx tsx united-microservice/united-service.ts &
# Start the main Next.js app (foreground)
npm start