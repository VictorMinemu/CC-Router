# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Port defaults — overridden by docker-compose environment section
ENV PORT=3456
ENV ACCOUNTS_PATH=/app/accounts.json

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3456

# accounts.json is expected to be mounted at runtime via docker-compose volume
# The container will exit with a clear error if it's not present
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start"]
