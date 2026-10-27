FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY . .
RUN npm run build

# ─── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=base /app/dist ./dist
# Migrations ship with the API image so `docker compose` can run them (service: migrate).
COPY db ./db

USER node
EXPOSE 3000

CMD ["node", "dist/server.js"]
