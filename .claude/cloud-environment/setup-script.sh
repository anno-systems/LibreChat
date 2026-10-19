#!/bin/bash
# Setup script for the Claude Code cloud environment (paste into the "Setup script" field).
# Runs as root on Ubuntu 24.04 BEFORE Claude Code starts. The result is cached as a
# filesystem snapshot if the script finishes in roughly 5 minutes, so keep it lean.
# Project-specific work (npm ci, .env, MongoDB container) lives in the repo's
# SessionStart hook (.claude/scripts/cloud-session-start.sh), not here.
#
# Rules from the docs: exit 0 (a non-zero exit stops the session from starting),
# so every non-critical step ends with "|| true".

NODE_VERSION="24.16.0"   # must match .nvmrc in the repo
NPM_VERSION="11.16.0"    # LibreChat docs: npm v11.16.0 (package.json pins npm@11.13.0)
MONGO_IMAGE="mongo:8"    # keep in sync with MONGO_IMAGE in .claude/scripts/dev-services.sh

# --- 1. Node 24 (the VM only ships Node 20/21/22) -------------------------------
if [ ! -x /opt/node24/bin/node ]; then
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  file="node-v${NODE_VERSION}-linux-x64.tar.xz"
  if curl -fsSL "${base}/${file}" -o "${tmp}/${file}" \
     && curl -fsSL "${base}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt" \
     && (cd "$tmp" && grep " ${file}\$" SHASUMS256.txt | sha256sum --check --status); then
    mkdir -p /opt/node24
    tar -xJf "${tmp}/${file}" -C /opt/node24 --strip-components=1 || true
  else
    echo "WARN: Node ${NODE_VERSION} download or checksum failed" >&2
  fi
  rm -rf "$tmp"
fi

if [ -x /opt/node24/bin/node ]; then
  ln -sf /opt/node24/bin/node /usr/local/bin/node
  ln -sf /opt/node24/bin/npm  /usr/local/bin/npm
  ln -sf /opt/node24/bin/npx  /usr/local/bin/npx
  PATH="/opt/node24/bin:$PATH" npm install -g "npm@${NPM_VERSION}" || true
fi

# --- 2. Pre-pull the MongoDB image so new sessions start fast (best effort) -----
# Docker is pre-installed. The daemon may not be running during setup, so try to
# start it. If any of this fails, the session hook pulls the image on first use.
if command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    (nohup dockerd >/var/log/dockerd-setup.log 2>&1 &)
    for _ in $(seq 1 20); do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  docker pull "$MONGO_IMAGE" || true
fi

exit 0
