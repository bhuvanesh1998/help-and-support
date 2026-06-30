# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────────
# Frontend image (Coolify "frontend" app — Base Directory = /frontend).
# Builds the Angular SPA and serves it with nginx on port 80. The backend API
# URL is injected at CONTAINER START (not build): docker-entrypoint writes
# /app-config.json from $API_BASE_URL, which the app loads before bootstrap.
# This means ONE image works against any backend origin without a rebuild.
# Build context = the frontend/ directory.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps --fetch-retries=6 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY . .
RUN npm run build            # → dist/help-assistant-ui/browser

# ---- Runtime ----
FROM nginx:alpine AS runtime
# SPA-aware nginx config (try_files fallback + asset caching).
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/help-assistant-ui/browser /usr/share/nginx/html
# Writes /app-config.json from $API_BASE_URL on every boot (runs via nginx's
# own /docker-entrypoint.d mechanism). chmod here so the host exec bit is irrelevant.
COPY docker-entrypoint.sh /docker-entrypoint.d/40-app-config.sh
RUN chmod +x /docker-entrypoint.d/40-app-config.sh
EXPOSE 80
