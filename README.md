# In-App Tutorial & Help Assistant

A link-aware, in-app help system: a floating assistant detects the active route, fetches matching multi-step tutorials, and renders them in a slide-out panel — backed by a secure backoffice for authoring routes, Markdown steps, and screenshots, with built-in analytics, media management, and SEO/AI-SEO support.

## Stack (verified current as of June 2026)

| Layer        | Technology                                                          |
| ------------ | ------------------------------------------------------------------- |
| Database     | PostgreSQL 17                                                       |
| ORM          | Prisma ORM 7 (Rust-free client)                                     |
| Runtime      | Node.js (24 LTS recommended; 26 Current supported) — native ESM     |
| API          | Express 5 + Helmet + JWT                                            |
| Frontend     | Angular 22 (signals, zoneless, standalone) + Angular Material (M3)  |
| Build (BE)   | TypeScript, `tsx` (dev), `tsc` (prod)                              |

> **Version note:** the original brief referenced *Angular 24* and *Node 26 LTS*. As of June 2026 the latest Angular is **22** (3 Jun 2026) — Angular 24 does not exist yet — and **Node 24** is the active LTS while **Node 26** is the *Current* (non-LTS) line. This project targets the real current releases.

## Phase status

| Phase | Scope                                                | State          |
| ----- | ---------------------------------------------------- | -------------- |
| 1     | Database engine & API foundation                     | ✅ Delivered    |
| 2     | JWT auth, public + admin CRUD, media upload engine   | ✅ Delivered    |
| 3     | Angular public floating assistant                    | ✅ Delivered    |
| 4     | Angular backoffice + analytics dashboards            | ✅ Delivered    |

## Quick start (Phases 1 & 2)

```bash
# 1. Configure environment
cp backend/.env.example backend/.env      # fill in DATABASE_URL, JWT_SECRET, etc.

# 2. Backend
cd backend
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run db:seed
npm run dev                               # http://localhost:3000/api/health
```

## Phase 2 API surface

| Area   | Method | Route                                       | Auth     |
|--------|--------|---------------------------------------------|----------|
| Auth   | POST   | `/api/admin/auth/login`                     | Public   |
| Auth   | POST   | `/api/admin/auth/refresh`                   | Public   |
| Auth   | GET    | `/api/admin/auth/me`                        | Bearer   |
| Public | GET    | `/api/public/pages?routePath=/some/path`    | Public   |
| Public | POST   | `/api/public/events`                        | Public   |
| Pages  | GET    | `/api/admin/pages`                          | Bearer   |
| Pages  | POST   | `/api/admin/pages`                          | Bearer   |
| Pages  | GET    | `/api/admin/pages/:id`                      | Bearer   |
| Pages  | PATCH  | `/api/admin/pages/:id`                      | Bearer   |
| Pages  | DELETE | `/api/admin/pages/:id`                      | Bearer   |
| Steps  | GET    | `/api/admin/pages/:pageId/steps`            | Bearer   |
| Steps  | POST   | `/api/admin/pages/:pageId/steps`            | Bearer   |
| Steps  | PATCH  | `/api/admin/pages/:pageId/steps/:stepId`    | Bearer   |
| Steps  | DELETE | `/api/admin/pages/:pageId/steps/:stepId`    | Bearer   |
| Steps  | POST   | `/api/admin/pages/:pageId/steps/reorder`    | Bearer   |
| Media  | POST   | `/api/admin/media`                          | Bearer   |
| Media  | GET    | `/api/admin/media`                          | Bearer   |
| Media  | GET    | `/api/admin/media/:id`                      | Bearer   |
| Media  | PATCH  | `/api/admin/media/:id`                      | Bearer   |
| Media  | DELETE | `/api/admin/media/:id`                      | Bearer   |
| Users  | GET    | `/api/admin/users`                          | SUPER_ADMIN |
| Users  | POST   | `/api/admin/users`                          | SUPER_ADMIN |
| Users  | PATCH  | `/api/admin/users/:id`                      | Bearer   |
| Users  | DELETE | `/api/admin/users/:id`                      | SUPER_ADMIN |

Health checks: `GET /api/health` (liveness) and `GET /api/health/ready` (DB readiness).

## Phase 3 — Floating help widget

The Angular `HelpWidget` component lives in `frontend/src/app/features/help-widget/`. It embeds in any route-aware Angular app:

```ts
// app.ts
import { HelpWidget } from './features/help-widget/help-widget';
@Component({ imports: [RouterOutlet, HelpWidget], template: `<router-outlet/><ha-help-widget/>` })
export class App {}
```

## Phase 4 — Admin backoffice

**Start the frontend dev server:**

```bash
cd frontend
npm install
npm run start    # http://localhost:4200
```

**Login:** `http://localhost:4200/admin/login` using the credentials from `backend/.env`
(`SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD`).

### Admin routes

| Path                  | Component          | Guard         |
|-----------------------|--------------------|---------------|
| `/admin/login`        | Login              | Public        |
| `/admin/pages`        | Pages list         | Authenticated |
| `/admin/pages/:id`    | Page + Steps CRUD  | Authenticated |
| `/admin/media`        | Media manager      | Authenticated |
| `/admin/analytics`    | Analytics dashboard| Authenticated |
| `/admin/users`        | Users management   | SUPER_ADMIN   |

### Frontend tech

- Angular 21, zoneless (`provideZonelessChangeDetection`)
- Angular Material M3 + `@widescreen/medicore-theme` SCSS tokens
- Signals-based state (`AuthStore`, all component state)
- Lazy-loaded routes per feature
- `authInterceptor` injects `Authorization: Bearer <token>` on all `/admin/` requests
