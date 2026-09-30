#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Backend container entrypoint.
#
# 1. As root: make sure the persistent volumes are writable by the `node` user
#    (volumes created by older images are owned by root), then drop privileges.
# 2. As node: bring the schema up to date, optionally seed, start the server.
#
# Schema modes (env):
#   default                      prisma migrate deploy. Additive, recorded, never
#                                drops data. New tables arrive as new migrations.
#                                A failure stops the container (Coolify keeps the
#                                previous one running) instead of booting against
#                                a half-migrated schema.
#   MIGRATE_BASELINE=true        ONE-TIME, for a database that was built with
#                                `prisma db push` and has no migration history
#                                (error P3005). Syncs the schema without data loss,
#                                marks every migration as applied, then deploys.
#   RUN_DB_PUSH=true             ONE-TIME bootstrap via `prisma db push` + seed.
#                                Refuses destructive changes unless
#                                DB_PUSH_ACCEPT_DATA_LOSS=yes-i-understand.
#                                Prefer the default + RUN_SEED=true on a fresh DB.
#   RUN_SEED=true                run prisma/seed.ts after the schema step
#                                (idempotent: creates the super admin if missing).
#   SKIP_DB_SYNC=true            do nothing to the schema.
# ──────────────────────────────────────────────────────────────────────────────
set -eu

APP_DIR=/app/backend
PRISMA="$APP_DIR/node_modules/.bin/prisma"
TSX="$APP_DIR/node_modules/.bin/tsx"

if [ "$(id -u)" = "0" ]; then
  for dir in "$APP_DIR/uploads" "$APP_DIR/exports"; do
    mkdir -p "$dir"
    # Only walk the tree when the volume root is not already ours: a large
    # uploads volume would otherwise be re-chowned on every restart.
    if [ "$(stat -c %u "$dir")" != "$(id -u node)" ]; then
      echo "entrypoint: fixing ownership of $dir"
      chown -R node:node "$dir"
    fi
  done
  exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node "$0" "$@"
fi

baseline() {
  echo "entrypoint: marking all migrations as applied (baseline)"
  for m in "$APP_DIR"/prisma/migrations/*/; do
    name=$(basename "$m")
    # Already-recorded migrations fail with P3008; that is the desired state.
    "$PRISMA" migrate resolve --applied "$name" >/dev/null 2>&1 \
      && echo "  baselined $name" || echo "  $name already recorded"
  done
}

if [ "${SKIP_DB_SYNC:-}" = "true" ]; then
  echo "entrypoint: SKIP_DB_SYNC=true - schema left untouched"
elif [ "${RUN_DB_PUSH:-}" = "true" ]; then
  echo "entrypoint: RUN_DB_PUSH=true - bootstrap with prisma db push"
  if [ "${DB_PUSH_ACCEPT_DATA_LOSS:-}" = "yes-i-understand" ]; then
    echo "entrypoint: WARNING - DB_PUSH_ACCEPT_DATA_LOSS set, destructive changes allowed"
    "$PRISMA" db push --accept-data-loss
  else
    "$PRISMA" db push
  fi
  baseline
  "$PRISMA" migrate deploy
  RUN_SEED=true
elif [ "${MIGRATE_BASELINE:-}" = "true" ]; then
  echo "entrypoint: MIGRATE_BASELINE=true - syncing db-push schema, then baselining"
  "$PRISMA" db push
  baseline
  "$PRISMA" migrate deploy
else
  if ! "$PRISMA" migrate deploy; then
    echo "entrypoint: ERROR - prisma migrate deploy failed." >&2
    echo "  P3005 (database not empty): it was built with db push. Deploy once with" >&2
    echo "  MIGRATE_BASELINE=true, then remove the variable." >&2
    echo "  Otherwise fix the failing migration; set SKIP_DB_SYNC=true to boot anyway." >&2
    exit 1
  fi
fi

if [ "${RUN_SEED:-}" = "true" ]; then
  "$TSX" prisma/seed.ts || echo "entrypoint: WARN - seed failed (continuing)"
fi

exec "$@"
