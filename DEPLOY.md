# Deploying to Easypanel — QA (182.156.249.170)

QA deploy on Easypanel's **built-in wildcard domain** `*.3mnqpo.easypanel.host`,
which already resolves to this server and gets **automatic HTTPS** — no registrar
DNS needed. The app runs as **one service**: the Express backend serves the REST
API *and* the built Angular SPA on a single origin. Postgres already runs on this
server, so no new database is needed.

Chosen QA hostname (any label under the wildcard works):

    https://help-qa.3mnqpo.easypanel.host

## 1. Get the source to Easypanel

- **Git (recommended):** push this `inapp-help-assistant/` folder to a repo
  (GitHub/GitLab). In Easypanel, create an **App** service → Source = Git →
  Build = **Dockerfile** (path `Dockerfile`, context `/`).
- **Docker image:** build & push to a registry, then App service → Source = Image.

> The `Dockerfile` and `.dockerignore` here are ready for either path.

## 2. Create the App service

- **Build:** Dockerfile (root of this folder).
- **Container port:** `3000`.
- **Domain:** App service → **Domains** → Add `help-qa.3mnqpo.easypanel.host`,
  target port `3000`, **HTTPS on**. TLS is issued automatically (wildcard cert).
  No host port mapping needed — the proxy routes 443 → container 3000.

## 3. Environment variables

Set these on the service (see `backend/.env.production.example`):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `PUBLIC_BASE_URL` | `https://help-qa.3mnqpo.easypanel.host` |
| `CORS_ORIGIN` | `https://help-qa.3mnqpo.easypanel.host` |
| `EMBED_ALLOWED_ORIGINS` | client sites allowed to embed the widget (space-separated) or `*` |
| `DATABASE_URL` | the existing `…@HOST:5565/twixordocs` connection string |
| `JWT_SECRET` | a 64+ char hex secret (generated for you — paste from chat) |

## 4. Persistent volume for uploads (REQUIRED)

Mount a volume at **`/app/backend/uploads`**. Without it, uploaded/restored
images are lost on every redeploy.

## 5. First deploy — seed content + images

The database already has the content rows, but the **image files** live only on
the dev machine and the stored URLs point at `localhost`. Because
`PUBLIC_BASE_URL` is already the final QA domain, restoring fixes both at once:

1. Open `https://help-qa.3mnqpo.easypanel.host/admin`.
2. On the **dev** machine: Pages → Export → **Backup (.zip)**.
3. On QA: Pages → Export → **Restore from backup…** and upload that `.zip`.
   Restore writes every image into the uploads volume **and rewrites all image
   URLs to the QA domain** — screenshots resolve over HTTPS immediately.

## 6. Schema changes (later)

The current DB is already in sync. If the Prisma schema changes, run
`npx prisma db push` (or add migrations) against `DATABASE_URL` before deploy.
The container does **not** auto-migrate, to avoid surprising data.

## 7. Custom domain later (optional)

To move off the QA hostname to e.g. `help.twixor.com`: add an A record
`help → 182.156.249.170` at your registrar, add that host in the service's
**Domains** tab (port 3000, HTTPS on), update `PUBLIC_BASE_URL`/`CORS_ORIGIN`,
redeploy, and re-run **Restore** once to re-point image URLs.

## Notes
- **QA shares the production database** (`twixordocs`). Edits/restores on QA hit
  the same data the dev app uses. For an isolated QA, create a separate database
  and point `DATABASE_URL` at it (then run `prisma db push` to create the schema).
- The image bundles dev dependencies for build reliability; it can be slimmed
  later with a prod-only `npm ci --omit=dev` + selective Prisma client copy.
- After setup, **rotate the Easypanel API token** that was shared.
