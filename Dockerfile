# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────────
# Single-image deploy: the Express backend serves the REST API *and* the built
# Angular SPA (NODE_ENV=production → express.static + SPA fallback). Prisma uses
# the @prisma/adapter-pg driver, so no query-engine binary is needed at runtime.
#
# ONE sequential build stage (not parallel multi-stage): frontend, then backend,
# one heavy step at a time. This keeps peak memory low so a small build server's
# OOM killer doesn't take out `ng build` / `tsc`.
# Build context = the inapp-help-assistant/ directory.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:24-alpine AS build
WORKDIR /app

# ---- Frontend (install → build) ----
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci --legacy-peer-deps --include=dev --fetch-retries=6 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY frontend/ ./frontend/
RUN cd frontend && npm run build            # → frontend/dist/help-assistant-ui/browser

# ---- Backend (install → generate client → compile) ----
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --legacy-peer-deps --include=dev --fetch-retries=6 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY backend/ ./backend/
RUN cd backend && npx prisma generate && npm run build   # → backend/dist

# ---- Runtime ----
# Use Debian-based slim (not Alpine) — Playwright/Chromium needs glibc and
# system libs that Alpine cannot satisfy even with --with-deps.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

# Backend with its (working) node_modules + generated Prisma client.
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/package*.json ./
COPY --from=build /app/backend/prisma ./prisma
COPY --from=build /app/backend/prisma.config.ts ./

# The server resolves the SPA at ../frontend/dist/help-assistant-ui/browser.
COPY --from=build /app/frontend/dist ../frontend/dist

# Install Chromium + all OS-level deps required by Playwright.
# PLAYWRIGHT_BROWSERS_PATH is unset so it defaults to ~/.cache/ms-playwright
# which is fine for a single-container image.
RUN npx playwright install chromium --with-deps

# Uploads live here; mount a persistent volume at this path.
RUN mkdir -p /app/backend/uploads

EXPOSE 3000
# On a fresh DB (set RUN_DB_PUSH=true), sync the schema and seed the super admin
# before starting. Both steps are idempotent, so they are safe on every boot.
# Leave RUN_DB_PUSH unset in environments whose schema you manage manually.
CMD ["sh","-c","if [ \"$RUN_DB_PUSH\" = \"true\" ]; then npx prisma db push --accept-data-loss && (npx tsx prisma/seed.ts || true); fi; exec node dist/server.js"]
