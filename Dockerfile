FROM node:20-alpine

# Set Asia/Dhaka (+06:00) timezone
ENV TZ="Asia/Dhaka"
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone

# Install PM2 process manager globally
RUN npm install -g pm2

# Set container working directory
WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Create persistent storage volume directory
RUN mkdir -p /data

# Expose Web Control Panel port
EXPOSE 3000

# Start production daemon with PM2 runtime
CMD ["pm2-runtime", "ecosystem.config.js"]
