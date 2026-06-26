# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────────
# Single-image deploy: the Express backend serves the REST API *and* the built
# Angular SPA (NODE_ENV=production → express.static + SPA fallback). One service,
# one domain. Prisma uses the @prisma/adapter-pg driver, so no query-engine
# binary is needed at runtime.
# Build context = the inapp-help-assistant/ directory.
# ──────────────────────────────────────────────────────────────────────────────

# ---- 1. Build the Angular SPA ----------------------------------------------
FROM node:24-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps --include=dev --fetch-retries=6 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY frontend/ ./
RUN npm run build            # → dist/help-assistant-ui/browser (production config)

# ---- 2. Build the backend (compile TS + generate Prisma client) ------------
FROM node:24-alpine AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --legacy-peer-deps --include=dev --fetch-retries=6 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY backend/ ./
RUN npx prisma generate && npm run build   # → dist/

# ---- 3. Runtime ------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

# Bring the built backend with its (working) node_modules + generated client.
COPY --from=backend /app/backend/node_modules ./node_modules
COPY --from=backend /app/backend/dist ./dist
COPY --from=backend /app/backend/package*.json ./
COPY --from=backend /app/backend/prisma ./prisma
COPY --from=backend /app/backend/prisma.config.ts ./

# The server resolves the SPA at ../frontend/dist/help-assistant-ui/browser.
COPY --from=frontend /app/frontend/dist ../frontend/dist

# Uploads live here; mount a persistent volume at this path in Easypanel.
RUN mkdir -p /app/backend/uploads

EXPOSE 3000
# On a fresh DB (set RUN_DB_PUSH=true), sync the schema and seed the super admin
# before starting. Both steps are idempotent, so they are safe on every boot.
# Leave RUN_DB_PUSH unset in environments whose schema you manage manually.
CMD ["sh","-c","if [ \"$RUN_DB_PUSH\" = \"true\" ]; then npx prisma db push --skip-generate && (npx prisma db seed || true); fi; exec node dist/server.js"]
