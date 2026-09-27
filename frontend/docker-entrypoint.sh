#!/bin/sh
# Write the runtime config the Angular app loads at bootstrap (see app.config.ts).
# Runs via nginx's /docker-entrypoint.d mechanism before the server starts, so the
# same image targets any backend origin by setting $API_BASE_URL in the environment.
set -e

CONFIG_PATH="/usr/share/nginx/html/app-config.json"
API_BASE_URL="${API_BASE_URL:-/api}"

cat > "$CONFIG_PATH" <<EOF
{ "apiBaseUrl": "${API_BASE_URL}" }
EOF

echo "[app-config] wrote ${CONFIG_PATH} (apiBaseUrl=${API_BASE_URL})"
