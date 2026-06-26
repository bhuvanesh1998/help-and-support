# Deploying to Easypanel (182.156.249.170)

The app deploys as **one service**: the Express backend serves both the REST API
and the built Angular SPA on a single domain. Postgres already runs on this
server, so no new database is needed.

## 1. Get the source to Easypanel

Easypanel builds from a **Git repo** or a **Docker image**. Pick one:

- **Git (recommended):** push this `inapp-help-assistant/` folder to a repo
  (GitHub/GitLab). In Easypanel, create an **App** service → Source = Git →
  Build = **Dockerfile** (path `Dockerfile`, context `/`).
- **Docker image:** build & push the image to a registry, then create an App
  service → Source = Image.

> The `Dockerfile` and `.dockerignore` in this folder are ready for either path.

## 2. Create the App service

- **Build:** Dockerfile (root of this folder).
- **Port:** `3000` (the container listens here).
- **Domain:** assign your hostname (e.g. `help.twixor.com`) and enable HTTPS.

## 3. Environment variables

Set these on the service (see `backend/.env.production.example`). The critical ones:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `PUBLIC_BASE_URL` | your domain, e.g. `https://help.twixor.com` |
| `CORS_ORIGIN` | your domain (comma-separated if multiple) |
| `EMBED_ALLOWED_ORIGINS` | client sites allowed to embed the widget (space-separated) or `*` |
| `DATABASE_URL` | the existing `…@HOST:5565/twixordocs` connection string |
| `JWT_SECRET` | a 64+ char hex secret (generated for you — paste from chat) |

## 4. Persistent volume for uploads (REQUIRED)

Mount a volume at **`/app/backend/uploads`**. Without it, uploaded/restored
images are lost on every redeploy.

## 5. First deploy — seed content + images

The database already has the content rows, but the **image files** live only on
the dev machine and the stored URLs point at `localhost`. Fix both in one step:

1. Deploy the service and open `https://<your-domain>/admin`.
2. Go to **Pages → Export → Restore from backup…** and upload the backup
   `.zip` (Pages → Export → *Backup (.zip)* on the dev machine first).
3. Restore writes all images into the uploads volume **and rewrites every image
   URL to the production domain** — so screenshots resolve correctly.

## 6. Schema changes (later)

The current DB is already in sync. If the Prisma schema changes in future, run
`npx prisma db push` (or add migrations) against `DATABASE_URL` before/▶ during
deploy. The container does **not** auto-migrate, to avoid surprising prod data.

## Notes
- The image bundles dev dependencies for build reliability; it can be slimmed
  later with a prod-only `npm ci --omit=dev` + selective Prisma client copy.
- After setup, **rotate the Easypanel API token** that was shared.
