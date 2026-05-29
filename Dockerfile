FROM node:20-alpine

WORKDIR /app

# dumb-init ensures Node doesn't run as PID 1.
# PID 1 has special responsibilities (signal handling, zombie reaping).
# dumb-init handles these correctly and forwards signals to Node.
RUN apk add --no-cache dumb-init

# Copy package files first (separate layer — only reinstalls when deps change)
COPY package*.json ./

# Install production dependencies only
# npm ci is faster and more reproducible than npm install in CI/Docker
RUN npm ci --only=production

# Copy source code
COPY . .

# Create a non-root user and run as them (security best practice)
RUN addgroup -g 1001 -S nodejs && adduser -S payflow -u 1001
USER payflow

EXPOSE 3000

# dumb-init is the entrypoint; CMD is what dumb-init runs
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
