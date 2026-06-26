# Backend — Help Assistant API

Native-ESM TypeScript API on Express 5, PostgreSQL via Prisma ORM 7.

## Prerequisites

- Node.js 24 LTS (or 26 Current)
- A running PostgreSQL 17 (use the root `docker compose up -d db`)

## Setup

```bash
cp .env.example .env          # fill in real secrets
npm install
npm run prisma:generate       # generate the typed client
npm run prisma:migrate -- --name init   # create tables
npm run db:seed               # create the first SUPER_ADMIN
npm run dev                   # watch mode
```

## Scripts

| Script                 | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `npm run dev`          | Watch-mode dev server (`tsx`)            |
| `npm run build`        | Compile to `dist/`                       |
| `npm start`            | Run compiled server                      |
| `npm run typecheck`    | `tsc --noEmit`                           |
| `npm run prisma:migrate` | Create/apply a dev migration           |
| `npm run prisma:deploy`  | Apply migrations in production         |
| `npm run prisma:studio`  | Visual data browser                    |
| `npm run db:seed`        | Seed initial admin                     |

## Structure

```
backend/
├── prisma/
│   ├── schema.prisma        # User, Page, TutorialStep, MediaAsset, AnalyticsEvent
│   └── seed.ts              # idempotent SUPER_ADMIN seed
├── prisma.config.ts         # Prisma 7 config (schema + seed wiring)
├── src/
│   ├── config/env.ts        # validated env (fails fast on missing secrets)
│   ├── lib/
│   │   ├── prisma.ts        # PrismaClient singleton
│   │   └── logger.ts        # structured logger
│   ├── middleware/
│   │   ├── error-handler.ts # unified error → JSON (AppError + Prisma)
│   │   └── not-found.ts     # 404 handler
│   ├── routes/
│   │   └── health.routes.ts # liveness + DB readiness
│   ├── utils/app-error.ts   # typed operational errors
│   ├── app.ts               # Express assembly (helmet, cors, parsing, routes)
│   └── server.ts            # bootstrap + graceful shutdown
├── .env.example
└── tsconfig.json
```

## Security posture (Phase 1)

- Secrets are env-only; the process refuses to boot without `DATABASE_URL` and `JWT_SECRET`.
- `helmet` sets hardened HTTP headers; CORS is an explicit env-driven allow-list.
- Passwords are hashed with bcrypt (cost 12); IPs in analytics are stored only as salted hashes.
- JSON/body size limited to 1 MB to blunt trivial payload-flood attempts.
