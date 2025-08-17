FROM node:20.18.0-alpine

WORKDIR /app
# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    nss \
    chromium \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    nodejs \
    yarn \
    xvfb \
    xdpyinfo \
    x11vnc

# Install noVNC and websockify
RUN apk add --no-cache git python3 py3-pip \
    && git clone https://github.com/novnc/noVNC.git /opt/novnc \
    && git clone https://github.com/novnc/websockify /opt/novnc/utils/websockify \
    && ln -s /opt/novnc/vnc.html /opt/novnc/index.html

# Install Python dependencies in a virtual environment
COPY requirements.txt ./
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip3 install --no-cache-dir -r requirements.txt

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci

# Install Playwright browsers
RUN npx playwright install

# Copy the rest of your app
COPY . .

# Build your app
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
EXPOSE 5900
EXPOSE 6080

# Install cron
RUN apk update && apk add --no-cache dcron

# Copy your crontab file
COPY docker/combined-crontab /etc/cron.d/combined-crontab

# Give execution rights on the cron job file
RUN chmod 0644 /etc/cron.d/combined-crontab

# Apply cron job
RUN crontab /etc/cron.d/combined-crontab

# Create log file for cron output
RUN touch /app/batch.log /var/log/cron.log

# (Optional) Make sure any shell scripts are executable
RUN chmod +x /app/scripts/start-all.sh

# Start cron and all services
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 & export DISPLAY=:99 && crond -f & /app/scripts/start-all.sh"]