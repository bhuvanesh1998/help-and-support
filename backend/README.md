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

## Voiceover Studio configuration

`.env.example` is git-ignored, so the Voiceover Studio variables are documented
here. **All of them are only initial defaults** — every value is editable at
runtime under **Admin → VO Settings** and persisted in `voiceover_settings`, so a
saved row always wins over the environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_VIDEO_UPLOAD_MB` | `500` | Video upload ceiling (images use `MAX_UPLOAD_MB`) |
| `VOICEOVER_PROVIDER` | `anthropic` | Vision provider: `anthropic` \| `openai` \| `gemini` |
| `VOICEOVER_MODEL` | `claude-opus-5` | Model id — must belong to the chosen provider |
| `VOICEOVER_EFFORT` | `medium` | Reasoning depth (Anthropic only) |
| `VOICEOVER_MAX_TOKENS` | `12000` | Output ceiling per script request |
| `VOICEOVER_MAX_FRAMES` | `48` | Frames sampled per video — the dominant cost control |
| `VOICEOVER_FRAMES_PER_BATCH` | `12` | Frames per model request |
| `VOICEOVER_FRAME_WIDTH` | `960` | Frame downscale width in px |
| `VOICEOVER_FRAME_QUALITY` | `4` | ffmpeg `-q:v` (1 best … 31 worst) |
| `VOICEOVER_SCENE_THRESHOLD` | `0.3` | Scene-change sensitivity, 0–1 (lower catches more) |
| `VOICEOVER_MIN_FRAME_GAP_SEC` | `1.5` | Minimum spacing between sampled frames |
| `VOICEOVER_MIN_SEGMENT_SEC` | `4` | Shortest narration segment |
| `VOICEOVER_MAX_SEGMENT_SEC` | `14` | Longest narration segment |
| `VOICEOVER_WORDS_PER_MINUTE` | `150` | Speaking pace — sets every segment's word budget |
| `VOICEOVER_JOB_RETENTION_MIN` | `60` | How long a finished job stays reviewable |

Provider API keys are **not** environment variables: connect them under
**VO Settings**, where each is validated against the provider and then encrypted
at rest (`ai_credentials`). The Anthropic row is shared with the AI Pipeline, and
the ElevenLabs key for narration audio lives in the same store.

`ffmpeg`/`ffprobe` need no system install — they ship with the `ffmpeg-static`
and `ffprobe-static` packages, so local and container behaviour match.

### Data model

| Table | Holds |
| --- | --- |
| `voiceover_settings` | The single settings row (falls back to env when absent) |
| `voiceover_scripts` | One row per run; `sourceScriptId` links tone variants |
| `voiceover_segments` | The timed lines; `editedAt` marks hand-edits |
| `voiceover_frames` | Sampled stills, with on-disk paths so a re-tone needs no re-upload |
| `voiceover_audio` | Rendered clips; `kind` is `segment` or the stitched `timeline` |
| `voiceover_usage` | One row per billable provider call, for the usage report |

### Usage reporting

`GET /api/admin/voiceover/usage?days=30` (surfaced at **Voiceover → Usage**) reports
consumption in the units providers bill in — input/output tokens for the vision
models, characters for ElevenLabs — grouped by provider, model, activity, day and
script. Failed calls are recorded too, since a failed request is spend with no
output.

It is deliberately **not** priced. Rates differ per account and change, so a
figure derived from hardcoded prices would read as authoritative while being
wrong; apply your own rates to the units. `voiceover_usage.scriptId` is not a
foreign key on purpose — deleting a script must not erase what it cost, so those
rows survive and appear without a name. Local ffmpeg work (frame extraction,
timeline assembly) costs nothing at a provider and is not recorded.

Migrations live in `prisma/migrations/` and the database has been baselined, so
`npm run prisma:deploy` works normally. Earlier tables were created outside
Prisma, which made `migrate deploy` fail with `P3005`; each migration was
verified as genuinely applied and then recorded with
`prisma migrate resolve --applied <name>`.

A fresh environment pointed at an existing, already-populated database needs the
same treatment — verify the objects exist, then resolve each migration rather
than letting Prisma replay them.

### Generated media is publicly served

Frame stills and narration MP3s are written to `UPLOAD_DIR` and served from
`/uploads`, which has no auth — the same path the help-manual images use. Fine
for local and internal use; restrict it before exposing this to the internet.

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
