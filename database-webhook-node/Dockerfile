# ── Database & Webhook Service ─────────────────────────────────
# Dhruv's microservice: Postgres persistence + Socket.IO emitter
# ───────────────────────────────────────────────────────────────

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cache-friendly layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

EXPOSE 3003

CMD ["node", "index.js"]
