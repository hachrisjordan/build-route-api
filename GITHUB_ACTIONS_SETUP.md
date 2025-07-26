# GitHub Actions Setup with Redis (Self-Hosted VPS)

## 🚀 Overview

This guide explains how to set up GitHub Actions for automated deployment with **hardcoded Redis configuration** for self-hosted VPS. The setup includes:

- Automated Docker image building
- Hardcoded Redis configuration for VPS deployment
- VPS deployment with health checks
- Environment variable management (excluding Redis)

## 📋 Required GitHub Secrets

Add these secrets in your GitHub repository: **Settings → Secrets and variables → Actions**

### Core Secrets
```bash
# Docker Hub
DOCKERHUB_USERNAME=your_dockerhub_username
DOCKERHUB_TOKEN=your_dockerhub_token

# VPS Deployment
VPS_HOST=your_vps_ip_or_domain
VPS_USER=your_vps_username
VPS_SSH_KEY=your_private_ssh_key

# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
SUPABASE_URL=your_supabase_url

# Valkey (existing service - DO NOT CHANGE)
VALKEY_HOST=valkey
VALKEY_PORT=6379
VALKEY_PASSWORD=your_valkey_password

# Proxy (for microservices)
PROXY_HOST=your_proxy_host
PROXY_PORT=your_proxy_port
PROXY_USERNAME=your_proxy_username
PROXY_PASSWORD=your_proxy_password
```

### ⚠️ Redis Configuration (Hardcoded)

Redis is **hardcoded** in the production configuration:

```yaml
# In docker-compose.prod.yml
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password_here  # Change this in the file
```

**To change the Redis password:**
1. Edit `docker-compose.prod.yml`
2. Replace `your_redis_password_here` with your desired password
3. Update the same password in `deploy.sh`

## 🔧 Workflow Files

### 1. Docker Image CI (`.github/workflows/docker-image.yml`)

This workflow:
- Builds Docker image with environment variables (excluding Redis)
- Pushes to Docker Hub
- Deploys to VPS with hardcoded Redis support

### 2. CI/CD (`.github/workflows/ci-cd.yml`)

This workflow:
- Runs Node.js build tests
- Deploys using the deployment script

## 🐳 Production Docker Compose

The `docker-compose.prod.yml` file is optimized for production with:

- **Hardcoded Redis configuration** for self-hosted VPS
- Separate Redis and Valkey instances
- Proper networking
- Health checks
- Volume persistence
- Nginx reverse proxy (optional)

## 📦 Deployment Process

### 1. GitHub Actions Triggers
- **Push to main branch**: Triggers full build and deployment
- **Pull Request**: Triggers build test only

### 2. Build Process
```bash
# 1. Checkout code
# 2. Build Docker image with environment variables
# 3. Push to Docker Hub
# 4. Deploy to VPS with hardcoded Redis
```

### 3. VPS Deployment
```bash
# 1. SSH to VPS
# 2. Create .env file with secrets (no Redis needed)
# 3. Run deploy.sh script
# 4. Health checks for all services
```

## 🔍 Health Checks

The deployment script includes health checks for:

- ✅ Redis connection (hardcoded password)
- ✅ Valkey connection  
- ✅ API health endpoint
- ✅ Container status

## 🛠️ Manual Deployment

If you need to deploy manually:

```bash
# 1. SSH to your VPS
ssh user@your-vps

# 2. Navigate to project directory
cd /root/build-route-api

# 3. Create .env file with your secrets (no Redis needed)
cat <<EOF > .env
DOCKERHUB_USERNAME=your_username
NEXT_PUBLIC_SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
VALKEY_HOST=valkey
VALKEY_PORT=6379
VALKEY_PASSWORD=your_valkey_password
PROXY_HOST=your_proxy_host
PROXY_PORT=your_proxy_port
PROXY_USERNAME=your_proxy_username
PROXY_PASSWORD=your_proxy_password
EOF

# 4. Run deployment
./deploy.sh
```

## 🔧 Troubleshooting

### Common Issues

#### 1. Redis Connection Errors
```bash
# Check Redis container
docker-compose -f docker-compose.prod.yml logs redis

# Test Redis connection (hardcoded password)
docker-compose -f docker-compose.prod.yml exec redis redis-cli -a "your_redis_password_here" ping
```

#### 2. Build Failures
```bash
# Check build logs
docker-compose -f docker-compose.prod.yml logs api

# Verify environment variables
docker-compose -f docker-compose.prod.yml exec api env | grep REDIS
```

#### 3. Deployment Failures
```bash
# Check deployment script logs
./deploy.sh

# Verify SSH connection
ssh -i ~/.ssh/your_key user@your-vps "echo 'SSH working'"
```

### Debug Commands

```bash
# View all containers
docker-compose -f docker-compose.prod.yml ps

# View logs for specific service
docker-compose -f docker-compose.prod.yml logs api

# Restart specific service
docker-compose -f docker-compose.prod.yml restart api

# Check Redis data (hardcoded password)
docker-compose -f docker-compose.prod.yml exec redis redis-cli -a "your_redis_password_here" keys "*"
```

## 🔒 Security Considerations

### 1. Environment Variables
- ✅ All sensitive data stored in GitHub Secrets
- ✅ Redis password hardcoded for self-hosted deployment
- ✅ Separate Redis and Valkey instances

### 2. Network Security
- ✅ Internal Docker networking
- ✅ Redis password protection
- ✅ Separate ports for different services

### 3. Container Security
- ✅ Non-root user in containers
- ✅ Minimal base images
- ✅ Regular security updates

## 📊 Monitoring

### 1. GitHub Actions
- Monitor workflow runs in Actions tab
- Check build logs for errors
- Verify deployment success

### 2. VPS Monitoring
```bash
# Check container status
docker-compose -f docker-compose.prod.yml ps

# Monitor resource usage
docker stats

# Check application logs
docker-compose -f docker-compose.prod.yml logs -f api
```

### 3. Redis Monitoring
```bash
# Check Redis info (hardcoded password)
docker-compose -f docker-compose.prod.yml exec redis redis-cli -a "your_redis_password_here" info

# Monitor Redis memory
docker-compose -f docker-compose.prod.yml exec redis redis-cli -a "your_redis_password_here" info memory
```

## 🚀 Next Steps

1. **Set up GitHub Secrets** with all required variables (excluding Redis)
2. **Change Redis password** in `docker-compose.prod.yml` and `deploy.sh`
3. **Test the workflow** with a small change
4. **Monitor the deployment** and check all services
5. **Set up monitoring** for production alerts

## 📞 Support

If you encounter issues:

1. Check the GitHub Actions logs
2. Review the deployment script output
3. Verify all environment variables are set
4. Test Redis connections manually (with hardcoded password)
5. Check container logs for errors 