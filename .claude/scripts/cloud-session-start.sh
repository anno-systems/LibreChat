#!/bin/bash
# SessionStart hook: prepares a Claude Code CLOUD session for LibreChat work.
# Does nothing locally. Whatever this script prints becomes context for Claude,
# so details go to a log file and only short status lines are printed.
#
# Order: Node 24 on PATH -> .env -> MongoDB container -> npm ci + package builds.
# Dependency work is skipped while package.json / package-lock.json are unchanged
# (within the same VM; a fresh clone in a new VM installs again).

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1
LOG=/tmp/cloud-session-start.log
: > "$LOG"

# 1. Node (installed by the environment's setup script, version must match .nvmrc)
if [ -x /opt/node24/bin/node ]; then
  export PATH="/opt/node24/bin:$PATH"
  # Persist PATH for the commands Claude runs later in this session.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo 'export PATH="/opt/node24/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
  fi
  want="v$(tr -d '[:space:]' < .nvmrc 2>/dev/null)"
  have="$(node -v 2>/dev/null)"
  if [ "$want" != "v" ] && [ "$want" != "$have" ]; then
    echo "WARN: .nvmrc wants $want but node is $have. Update NODE_VERSION in the environment's setup script."
  fi
else
  echo "WARN: /opt/node24 missing - the environment setup script did not run or failed. LibreChat needs the Node version from .nvmrc."
fi

# 2. .env (only created if absent)
bash .claude/scripts/bootstrap-env.sh >>"$LOG" 2>&1 || echo "WARN: .claude/scripts/bootstrap-env.sh failed, see $LOG"

# 3. MongoDB for the app and the test suites
if bash .claude/scripts/dev-services.sh up >>"$LOG" 2>&1; then
  echo "MongoDB is running on 127.0.0.1:27017."
else
  echo "WARN: MongoDB container did not start, see $LOG"
fi

# 4. Dependencies and workspace package builds
hashes=node_modules/.cloud_install.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  if npm ci >>"$LOG" 2>&1 && npm run build:packages >>"$LOG" 2>&1; then
    sha256sum package.json package-lock.json .claude/scripts/cloud-session-start.sh > "$hashes" || rm -f "$hashes"
    echo "Dependencies installed and workspace packages built."
  else
    echo "WARN: npm ci / build:packages failed, see $LOG (tail below)"
    tail -n 20 "$LOG"
  fi
else
  echo "Dependencies unchanged, skipped install."
fi

exit 0
