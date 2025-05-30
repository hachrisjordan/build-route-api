# syntax=docker/dockerfile:1.4
# Stage 1: Build
FROM node:18-alpine AS builder

ARG NEXT_PUBLIC_SUPABASE_URL
ARG SUPABASE_SERVICE_ROLE_KEY
ARG SUPABASE_URL
ARG supabaseUrl

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
ENV SUPABASE_URL=$SUPABASE_URL
ENV supabaseUrl=$supabaseUrl

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Use BuildKit secrets for sensitive values (not baked into image)
RUN --mount=type=secret,id=supabase_service_role_key \
    --mount=type=secret,id=valkey_password \
    export SUPABASE_SERVICE_ROLE_KEY=$(cat /run/secrets/supabase_service_role_key) && \
    export VALKEY_PASSWORD=$(cat /run/secrets/valkey_password) && \
    npm run build

# Stage 2: Run
FROM node:18-alpine

ARG NEXT_PUBLIC_SUPABASE_URL
ARG SUPABASE_SERVICE_ROLE_KEY
ARG SUPABASE_URL
ARG supabaseUrl

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
ENV SUPABASE_URL=$SUPABASE_URL
ENV supabaseUrl=$supabaseUrl

WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]