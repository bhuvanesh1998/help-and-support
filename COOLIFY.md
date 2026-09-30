# Deploying to Coolify — two separate apps

This repo deploys as **two independent Coolify applications** built from the same
Git repository (`main` branch):

| App        | Base Directory | Build      | Port | Serves                                   |
| ---------- | -------------- | ---------- | ---- | ---------------------------------------- |
| `backend`  | `/backend`     | Dockerfile | 3000 | REST API, `/uploads`, widget, MCP bridge |
| `frontend` | `/frontend`    | Dockerfile | 80   | Angular SPA (nginx)                      |

The backend no longer serves the SPA — [backend/src/app.ts](backend/src/app.ts) only
serves the Angular build when it is physically present (single-image mode), so the
standalone backend runs API-only. The frontend learns the backend URL **at container
start** (no rebuild needed) via `/app-config.json`, written by its nginx entrypoint
from `$API_BASE_URL`.

---

## 1. Backend app

- **Source:** this repo, branch `main`. **Build Pack:** Dockerfile. **Base Directory:** `/backend`.
- **Port:** `3000`. **Domain:** add a Coolify-generated domain (auto HTTPS).
- **Persistent storage (REQUIRED):** mount a volume at **`/app/backend/uploads`** —
  without it, uploaded/restored images are lost on every redeploy.
- **Persistent storage (recommended):** mount a second volume at **`/app/backend/exports`**
  so generated exports survive redeploys.
- The container runs as the unprivileged **`node`** user (uid 1000). It starts as root
  only long enough to `chown` those volumes (existing root-owned volumes are fixed
  automatically on first boot), then drops privileges.
- A Docker `HEALTHCHECK` probes `GET /api/health` (liveness, no DB). In Coolify →
  Health Check, use path `/api/health`, port `3000`.
- **Environment variables** (see [backend/.env.production.example](backend/.env.production.example)):

| Variable                | Value                                              |
| ----------------------- | -------------------------------------------------- |
| `NODE_ENV`              | `production`                                       |
| `PORT`                  | `3000`                                             |
| `PUBLIC_BASE_URL`       | the backend app's own domain                       |
| `CORS_ORIGIN`           | the **frontend** app's domain (cross-origin XHR)   |
| `EMBED_ALLOWED_ORIGINS` | client sites allowed to embed the widget, or `*`   |
| `DATABASE_URL`          | the existing `…@HOST:5565/twixordocs` string       |
| `JWT_SECRET`            | a 64+ char hex secret                              |

> `CORS_ORIGIN` **must** be the frontend's origin — login/admin/analytics calls are
> now cross-origin.

### Database schema on start

Every start runs **`prisma migrate deploy`**: pending migrations from
`backend/prisma/migrations` are applied, nothing is ever dropped. New tables reach
production by committing a migration (`npm run prisma:migrate` locally), not by
`db push`. If a migration fails, the container exits and Coolify keeps the previous
deployment running.

| Variable                                     | Use                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| *(none)*                                     | Default: `prisma migrate deploy`.                                                                    |
| `RUN_SEED=true`                              | Also run `prisma/seed.ts` (needs `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD`). Idempotent. |
| `MIGRATE_BASELINE=true`                      | **One time**, for a DB built with `db push` (log shows `P3005`). Syncs the schema without data loss, marks every migration applied, then deploys. Remove afterwards. |
| `RUN_DB_PUSH=true`                           | **One time** legacy bootstrap: `prisma db push` + baseline + seed. Refuses destructive changes.       |
| `DB_PUSH_ACCEPT_DATA_LOSS=yes-i-understand`  | Only with `RUN_DB_PUSH=true`: allows `--accept-data-loss`. Never leave set.                          |
| `SKIP_DB_SYNC=true`                          | Leave the schema untouched.                                                                          |

- **Existing `twixordocs` DB (built with `db push`):** deploy once with
  `MIGRATE_BASELINE=true`, confirm the log shows `No pending migrations to apply`,
  then delete the variable and redeploy.
- **Fresh DB:** deploy with `RUN_SEED=true` (plus the two `SEED_SUPER_ADMIN_*`
  variables); remove them after the admin exists.

## 2. Frontend app

- **Source:** this repo, branch `main`. **Build Pack:** Dockerfile. **Base Directory:** `/frontend`.
- **Port:** `80`. **Domain:** add a Coolify-generated domain (auto HTTPS).
- **Environment variables:**

| Variable       | Value                                  |
| -------------- | -------------------------------------- |
| `API_BASE_URL` | `https://<backend-domain>/api`         |

The entrypoint writes `/app-config.json` = `{ "apiBaseUrl": "<API_BASE_URL>" }` on
boot; the Angular app fetches it before bootstrapping. Default (unset) is `/api`.

## 3. Order of operations

1. Create both apps so Coolify assigns their domains.
2. Set `API_BASE_URL` (frontend) = `https://<backend-domain>/api`.
3. Set `CORS_ORIGIN` (backend) = `https://<frontend-domain>`.
4. Deploy backend, then frontend.

## 4. First deploy — content images

The DB already has content rows, but image **files** live on the dev machine and stored
URLs may point at `localhost`. On the **frontend** (admin): Pages → Export → **Backup
(.zip)** from dev, then **Restore from backup…** on the deployed admin. Restore writes
images into the backend uploads volume and rewrites image URLs to `PUBLIC_BASE_URL`.

## 5. Verify

- `GET https://<backend-domain>/api/health` → `200`; `/api/health/ready` → DB OK.
- `https://<frontend-domain>/app-config.json` shows the backend `/api` URL.
- Open `https://<frontend-domain>/admin/login`, log in (confirms CORS), load Pages/Media
  (images load from the backend `/uploads`, served with `Access-Control-Allow-Origin: *`).

## Notes

- Reusing `twixordocs` means deployed edits/restores hit the same data as dev. For an
  isolated environment, point `DATABASE_URL` at a separate DB and deploy once with `RUN_SEED=true`.
- Custom domains: add them in each app's Domains tab, then update `PUBLIC_BASE_URL` /
  `CORS_ORIGIN` / `API_BASE_URL` accordingly and redeploy.
