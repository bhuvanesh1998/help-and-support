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

## 7. Custom domain + HTTPS (required for the embeddable widget)

The widget is blocked on secure (`https`) client sites when served over plain
`http`. Put the app behind a subdomain with TLS — Easypanel's built-in proxy
(Traefik) auto-issues a Let's Encrypt certificate.

**A. DNS** — at your domain registrar, add an **A record**:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `help` (→ `help.twixor.com`) | `182.156.249.170` | default |

Wait for it to resolve (`nslookup help.twixor.com` returns the IP). Ensure the
server's ports **80 and 443** are open — Let's Encrypt validates over port 80.

**B. Easypanel** — App service → **Domains** → Add domain:
- Host: `help.twixor.com`
- Container port: `3000`
- HTTPS: **on** (Let's Encrypt). The cert is issued automatically once DNS resolves.

With the domain attached via the proxy, the raw `8080→3000` published port is no
longer needed and can be removed.

**C. Update env to the HTTPS origin, then redeploy:**

| Var | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://help.twixor.com` |
| `CORS_ORIGIN` | `https://help.twixor.com` |
| `EMBED_ALLOWED_ORIGINS` | space-separated client sites, e.g. `https://app.acme.com` (or `*`) |

**D. Re-seed image URLs.** Stored image URLs are absolute and were written with
the *previous* origin. After switching the domain, just run **Pages → Export →
Restore from backup…** again — restore re-points every image URL to the current
`PUBLIC_BASE_URL`. (Tip: set the final domain *before* the first restore to skip
this step.)

Verify: `https://help.twixor.com/api/health` → 200, and the green padlock shows.

## Notes
- The image bundles dev dependencies for build reliability; it can be slimmed
  later with a prod-only `npm ci --omit=dev` + selective Prisma client copy.
- After setup, **rotate the Easypanel API token** that was shared.
