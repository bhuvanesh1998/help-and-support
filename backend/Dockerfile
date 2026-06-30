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

# Chromium + OS deps for Playwright (defaults to ~/.cache/ms-playwright).
RUN npx playwright install chromium --with-deps

# Uploads live here; mount a persistent volume at this path in Coolify.
RUN mkdir -p /app/backend/uploads

EXPOSE 3000
# On a fresh DB (set RUN_DB_PUSH=true) sync the schema and seed the super admin
# before starting. Both steps are idempotent. Leave RUN_DB_PUSH unset when the
# schema is managed manually (e.g. reusing an existing in-sync database).
CMD ["sh","-c","if [ \"$RUN_DB_PUSH\" = \"true\" ]; then npx prisma db push --accept-data-loss && (npx tsx prisma/seed.ts || true); fi; exec node dist/server.js"]
