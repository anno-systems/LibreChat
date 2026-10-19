#!/bin/bash
# Create a working .env for LibreChat development from .env.example (only if none exists).
# On creation it replaces the example secrets with fresh random dev values and points
# MONGO_URI at the local dev MongoDB. An existing .env is never touched.
#
# Usage (from anywhere in the repo): bash .claude/scripts/bootstrap-env.sh
set -eu

cd "$(dirname "$0")/../.."

if [ -f .env ]; then
  echo ".env already exists, leaving it untouched."
  exit 0
fi

if [ ! -f .env.example ]; then
  echo ".env.example not found, cannot create .env" >&2
  exit 1
fi

cp .env.example .env

set_var() { # set_var KEY VALUE  (replace the line or append it)
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}

rand_hex() { openssl rand -hex "$1"; }

set_var MONGO_URI "${MONGO_URI:-mongodb://127.0.0.1:27017/LibreChat}"
set_var CREDS_KEY "$(rand_hex 32)"
set_var CREDS_IV "$(rand_hex 16)"
set_var JWT_SECRET "$(rand_hex 32)"
set_var JWT_REFRESH_SECRET "$(rand_hex 32)"

echo "Created .env with fresh dev secrets (add real LLM API keys yourself if you need live chats)."
