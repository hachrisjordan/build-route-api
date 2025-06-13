FROM node:20.18.0-alpine

WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000

# Install cron
RUN apk update && apk add --no-cache dcron

# Copy your crontab file
COPY docker/jetblue-crontab /etc/cron.d/jetblue-crontab

# Give execution rights on the cron job file
RUN chmod 0644 /etc/cron.d/jetblue-crontab

# Apply cron job
RUN crontab /etc/cron.d/jetblue-crontab

# Create log file for cron output
RUN touch /app/batch.log /var/log/cron.log

# (Optional) Make sure any shell scripts are executable
RUN chmod +x /app/scripts/start-all.sh

# Start cron and all services
CMD sh -c "crond -f & /app/scripts/start-all.sh"