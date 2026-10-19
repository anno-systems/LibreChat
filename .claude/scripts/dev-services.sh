#!/bin/bash
# Start/stop the local dev services LibreChat needs (MongoDB) via Docker.
# Works the same on your PC and in Claude Code cloud sessions.
#
# Usage: bash .claude/scripts/dev-services.sh [up|down|status]
set -u

MONGO_IMAGE="${MONGO_IMAGE:-mongo:8}"   # keep in sync with the cloud setup script
NAME="librechat-dev-mongo"
VOLUME="librechat-dev-mongo-data"

ensure_docker() {
  docker info >/dev/null 2>&1 && return 0
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
    (nohup dockerd >/tmp/dockerd.log 2>&1 &)
    for _ in $(seq 1 30); do
      docker info >/dev/null 2>&1 && return 0
      sleep 1
    done
  fi
  echo "Docker daemon is not reachable. Start Docker (locally: Docker Desktop / dockerd)." >&2
  return 1
}

case "${1:-up}" in
  up)
    ensure_docker || exit 1
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "MongoDB container already running."
    elif docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker start "$NAME" >/dev/null
    else
      docker run -d --name "$NAME" \
        -p 127.0.0.1:27017:27017 \
        -v "$VOLUME":/data/db \
        "$MONGO_IMAGE" >/dev/null
    fi
    for _ in $(seq 1 30); do
      if docker exec "$NAME" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
        echo "MongoDB ready on 127.0.0.1:27017"
        exit 0
      fi
      sleep 1
    done
    echo "MongoDB did not become ready in 30s." >&2
    exit 1
    ;;
  down)
    ensure_docker || exit 1
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "MongoDB container removed (data volume $VOLUME kept)."
    ;;
  status)
    ensure_docker || exit 1
    docker ps --filter "name=$NAME"
    ;;
  *)
    echo "Usage: $0 [up|down|status]" >&2
    exit 2
    ;;
esac
