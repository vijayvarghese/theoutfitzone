FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only using reproducible lockfile
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code
COPY . .

# Ensure upload/volume mount directory exists and assign ownership to non-root user
RUN mkdir -p /app/public/products && \
    chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
