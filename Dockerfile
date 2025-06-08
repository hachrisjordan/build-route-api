# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Run
FROM node:18-alpine

WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]

ARG NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL

# Install cron
RUN apt-get update && apt-get install -y cron

# Copy your crontab file
COPY docker/jetblue-crontab /etc/cron.d/jetblue-crontab

# Give execution rights on the cron job
RUN chmod 0644 /etc/cron.d/jetblue-crontab

# Apply cron job
RUN crontab /etc/cron.d/jetblue-crontab

# Start cron and your app
CMD cron && npm run dev