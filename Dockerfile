FROM node:20.18.0-alpine

WORKDIR /app

# Install system dependencies for both Node.js and Python
RUN apk add --no-cache \
    python3 \
    py3-pip \
    python3-dev \
    make \
    g++ \
    nss \
    chromium \
    chromium-chromedriver \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    nodejs \
    yarn \
    xvfb \
    xdpyinfo \
    x11vnc \
    bash \
    curl \
    wget \
    git

# Install noVNC and websockify
RUN apk add --no-cache git python3 py3-pip \
    && git clone https://github.com/novnc/noVNC.git /opt/novnc \
    && git clone https://github.com/novnc/websockify /opt/novnc/utils/websockify \
    && ln -s /opt/novnc/vnc.html /opt/novnc/index.html

# Create Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV VIRTUAL_ENV="/opt/venv"

# Upgrade pip and install Python dependencies
RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel

# Install Python dependencies in the virtual environment
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Install additional Python packages for microservices
RUN pip3 install --no-cache-dir \
    undetected-chromedriver \
    selenium \
    python-dotenv \
    supabase \
    curl_cffi \
    flask

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci

# Install Playwright browsers
RUN npx playwright install

# Copy the rest of your app (csv-output/route_count.csv will be included due to .dockerignore exception)
COPY . .

# Ensure csv-output directory exists and route_count.csv is present
RUN mkdir -p /app/csv-output && \
    if [ ! -f /app/csv-output/route_count.csv ]; then \
      echo "WARNING: route_count.csv not found, creating empty file as fallback"; \
      echo "origin,destination,count" > /app/csv-output/route_count.csv; \
    else \
      echo "route_count.csv found successfully"; \
    fi

# Build your app
RUN npm run build
ENV NODE_ENV=production

# Expose ports
EXPOSE 3000
EXPOSE 4000
EXPOSE 4001
EXPOSE 4002
EXPOSE 4003
EXPOSE 4004
EXPOSE 4005
EXPOSE 4009
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

# Create log files for cron output
RUN touch /app/batch.log /app/cx_scraper.log /var/log/cron.log

# Make sure any shell scripts and Python scripts are executable
RUN chmod +x /app/scripts/start-all.sh
RUN chmod +x /app/scripts/run-cx-scraper.sh
RUN chmod +x /app/scripts/verify-cx-setup.sh
RUN chmod +x /app/scripts/test-cx-deployment.sh
RUN chmod +x /app/finnair-microservice/start-continuous-service.sh
RUN chmod +x /app/cx_availability_scraper.py
RUN chmod +x /app/delta-curl-cffi-perfect.py
RUN chmod +x /app/delta-microservice/docker-start-delta-perfect.sh

# Create shared Chrome data directory
RUN mkdir -p /app/chrome-data && chmod 777 /app/chrome-data

# Set Chrome environment variables for undetected-chromedriver
ENV CHROME_BIN=/usr/bin/chromium-browser
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver
ENV CHROME_DATA_DIR=/app/chrome-data

# Start cron and all services
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 & export DISPLAY=:99 && crond -f & /app/scripts/start-all.sh"]