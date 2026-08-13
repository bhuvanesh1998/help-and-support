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
| `roles` | Named permission sets; `isSystem` marks the seeded ones |

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

**`prisma migrate dev` is not usable on this database.** The baselined migrations
do not reproduce the current schema exactly (the pre-baseline tables were created
by hand), so `migrate dev` detects drift and offers to reset — which would drop
real data, and dev and prod share this database. Write the migration SQL by hand
under `prisma/migrations/<timestamp>_<name>/migration.sql`, apply it with
`npm run prisma:deploy`, then `npm run prisma:generate`.

### The merged track is the deliverable

`POST /scripts/:id/audio/timeline` mixes each line's take at its own timecode and
pads the result to the video's length, so the MP3 drops under the video as a
single layer with no nudging (verified: a 346.0s video produced a 346.3s track).

- Builds are **numbered and kept** (`voiceover_audio.segmentVersion` doubles as
  the build number for `kind = 'timeline'`). Losing the last good mix because a
  re-assembly went wrong is the worst outcome here, so an edit no longer deletes
  it. The four most recent builds are kept; older ones are pruned with their files.
- Each build records a `sourceSignature` — the `index:version` pairs it mixed. The
  UI compares it with the script and shows "lines have changed since this was
  assembled" rather than letting a stale track look current.
- Only takes matching each line's **current** wording are mixed, and the response
  reports `missing` so a track with silent gaps does not look finished.

### One voice per script

`voiceover_scripts.voiceId/voiceName/ttsModelId` pin the voice a script is
narrated in. It is set on the first render, and `POST /scripts/:id/audio/:index`
falls back to it when the request omits a voice — so a re-record months later
matches the takes around it.

This fixes a real defect: the UI defaulted its voice dropdown to the first voice
the account returned, so a single re-record could land in a different voice from
every other line (one script had 28 lines in one voice and 2 in another). The
detail page now reports takes that are off-voice and offers to re-record just
those.

### Narration version history

Editing a line **appends a version** instead of overwriting it, and the take
recorded from the previous wording is kept — filed under that version in
`voiceover_audio` (`segmentVersion`). Restoring a version points the line back at
it and its take becomes current again, so undoing an edit normally costs nothing.

| Table / column | Role |
| --- | --- |
| `voiceover_segment_versions` | Append-only history: text, word count, `source` (`generated` \| `edited`) |
| `voiceover_segments.version` | Which stored version `script` currently holds |
| `voiceover_audio.segmentVersion` | The wording a clip speaks; `0` for the derived timeline |

Consequences worth knowing:

- Re-saving unchanged text does **not** create a version — an undo history full of
  identical entries is worse than none.
- Restoring does not create a version either; it is a move along the history.
- The stitched timeline is still discarded on any edit or restore: it is a mix of
  words the script no longer says. It is rebuilt only from takes matching each
  line's current version, and the response reports `missing` so a track with
  silent gaps does not look finished.
- The audio ZIP puts superseded takes under `lines/superseded/…-v<n>.mp3` rather
  than dropping them, so an editor can still reach a version they preferred.

### Generated media is publicly served

Frame stills and narration MP3s are written to `UPLOAD_DIR` and served from
`/uploads`, which has no auth — the same path the help-manual images use. Fine
for local and internal use; restrict it before exposing this to the internet.

## Trash (30-day retention)

Deleting content moves it to the trash instead of destroying it. `GET
/api/admin/trash` lists what the caller may see; restore and permanent delete are
per item. Retention is **30 days** (`TRASH_RETENTION_DAYS`), stamped as an
absolute `expiresAt` at delete time so changing the window never silently re-dates
what is already in the trash.

Two mechanisms sit behind one screen, by design:

| Mechanism | Types | How |
| --- | --- | --- |
| **Captured** | Voiceover scripts, pages, categories | The rows are serialised into `trash_items.payload` and removed from their own tables |
| **Flagged** | Media assets | The pre-existing `media_assets.deletedAt` soft delete, adapted into the same list |

Capturing rather than flagging is deliberate: every existing list, count and join
stays correct without a `deletedAt IS NULL` filter threaded through the app, and a
filter missed in one query is exactly how "deleted" content reappears. Media keeps
its own flag because a still may still be referenced by a published page, and
rewriting that would break what already works.

- **Files are never deleted on trashing** — only on a permanent delete or expiry.
  A restored script whose MP3s had already been unlinked would be a restore in
  name only. Narration audio is removed on purge; frame stills are MediaAssets the
  library owns and are left alone.
- **Restores are whole**: a voiceover script returns with its lines, version
  history, frame records and every take; a page with its steps and API entries; a
  category re-files the pages that were under it (skipping any since moved).
- **Permissions**: `trash.view` opens the screen, but each item additionally needs
  its own type's permission — restoring a page is a page edit, so a role without
  `pages.view` neither sees nor restores pages.
- **The sweep** runs on boot, daily, and whenever the trash is opened. Each adapter
  computes its own cutoff: captured types compare `expiresAt` to now, media
  compares `deletedAt` to now − 30 days. A single shared cutoff was wrong for one
  of them (it purged captured items 60 days late) — hence the split.
- Analytics events are not part of a page's record; they detach (`SET NULL`) as
  they always did and are not restored.

## Roles & permissions

Two separate ideas, deliberately not merged:

| Concept | Column | Who can grant it | Effect |
| --- | --- | --- | --- |
| Account tier | `users.role` (`SUPER_ADMIN` \| `ADMIN`) | Super admins only | `SUPER_ADMIN` holds **every** permission unconditionally |
| Assigned role | `users.roleId` → `roles` | Anyone with `users.manage` | Decides which features the account can reach |

The permission catalogue lives in one place — `src/config/permissions.ts`. It is
served to the UI with `GET /api/admin/roles`, so the roles screen never hardcodes
a list that could drift from the server's. Adding a feature means adding an entry
there and guarding its router; nothing else.

- `manage` **implies** `view`, expanded server-side on save, so a hand-crafted API
  call cannot produce "can edit pages but cannot see them".
- Guards: `requireFeature('pages')` reads `pages.view` for GET and `pages.manage`
  for anything that changes state. `requirePermission('key')` is the explicit
  form, used where a router needs a single key (`analytics.view`, `roles.manage`)
  or where routes differ from each other — the Voiceover Studio guards each route
  individually, so a role may read scripts without spending API credit.
- Permissions are resolved **per request**, not carried in the JWT: a role edit
  takes effect immediately instead of at token expiry.
- An `ADMIN` with **no** role assigned gets `LEGACY_ADMIN_PERMISSIONS` —
  everything except users and roles. That was the behaviour before roles existed,
  so introducing them locked nobody out.
- Four roles are seeded on boot (Administrator, Content Editor, Voiceover
  Producer, Viewer). They can be renamed but their permission sets are fixed and
  they cannot be deleted, so there is always a coherent role to fall back on —
  duplicate one to customise it. Administrator's set is re-synced with the
  catalogue on boot, so a new feature reaches it without a manual edit.
- A role that any user still holds cannot be deleted, and deleting a role that
  somehow is (`ON DELETE SET NULL`) drops those users to the legacy fallback
  rather than deleting them.

Frontend guards (`permissionGuard`) and the filtered sidebar are **cosmetic** —
they keep a user off a screen that would 403 on every call. The API is the
boundary.

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
