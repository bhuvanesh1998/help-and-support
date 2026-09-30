# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────────
# Backend-only image (Coolify "backend" app — Base Directory = /backend).
# Serves the REST API, /uploads, the embeddable widget, the connector bridge and
# the MCP endpoint on port 3000. The Angular SPA is a SEPARATE app, so this image
# does NOT bundle or serve the frontend (app.ts guards SPA serving on presence).
#
# Prisma uses the @prisma/adapter-pg driver, so no query-engine binary is needed
# at runtime. Build context = the backend/ directory.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:24-slim AS build
WORKDIR /app/backend

# Install (incl. dev deps for tsc/tsx + prisma CLI), generate the client, compile.
COPY package*.json ./
RUN npm ci --include=dev --fetch-retries=6 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY . .
RUN npx prisma generate && npm run build   # → dist/

# ---- Runtime ----
# Debian-based slim (not Alpine): Playwright/Chromium needs glibc + system libs
# that Alpine cannot satisfy even with --with-deps. The AI-pipeline scraper uses it.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/package*.json ./
COPY --from=build /app/backend/prisma ./prisma
COPY --from=build /app/backend/prisma.config.ts ./
# Browser-extension files served by the MCP Connect "Download extension" button
# (zipped on demand by services/connector/extension-pack.ts).
COPY --from=build /app/backend/extension ./extension

# curl: Coolify's health check runs curl (or wget) inside the container, and
# the slim image ships neither — without it every deploy is marked unhealthy.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates     && rm -rf /var/lib/apt/lists/*

# Chromium + OS deps for Playwright. Installed to a shared path (not root's
# ~/.cache) so the unprivileged `node` user can launch it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium --with-deps && chmod -R a+rX /ms-playwright

# Dev dependencies are kept on purpose: the entrypoint needs the prisma CLI
# (migrate deploy) and tsx (prisma/seed.ts), both devDependencies.
# The CLI fetches its schema engine on first use; do that at build time, then
# let `node` own the engines dir in case Prisma needs to rewrite it later.
RUN ./node_modules/.bin/prisma version && chown -R node:node node_modules/@prisma/engines

# Persistent data: mount volumes at /app/backend/uploads and /app/backend/exports.
# The entrypoint re-chowns them to `node` if an older (root) image created them.
RUN mkdir -p /app/backend/uploads /app/backend/exports     && chown -R node:node /app/backend/uploads /app/backend/exports
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip CRLF in case the script was checked out on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
# Liveness only (no DB): a DB outage should not make Coolify kill the process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3   CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1

# Starts as root only to fix volume ownership, then drops to `node` (setpriv).
# Schema handling (migrate deploy by default) is documented in the entrypoint.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
