# Claude Code setup for this fork

Goal: work on this repo the same way locally and in Claude Code cloud sessions. In the cloud, Claude can push branches, build LibreChat and run the tests. Rules for the work itself are in `CLAUDE.md` at the repo root (it imports upstream's `AGENTS.md` and overrides the branch rules for this fork).

## Files

```
CLAUDE.md                              imports AGENTS.md, fork overrides, environment notes
.claude/settings.json                  permissions and the SessionStart hook
.claude/commands/verify.md             /verify: verification per AGENTS.md for the changed workspaces
.claude/scripts/cloud-session-start.sh prepares every cloud session (inactive locally)
.claude/scripts/dev-services.sh        start/stop MongoDB in Docker (local and cloud)
.claude/scripts/bootstrap-env.sh       create .env with fresh dev secrets
.claude/cloud-environment/             this folder: values for the cloud environment
```

Upstream's `.gitignore` ignores `/.claude/` and `CLAUDE.md`. These files were added with `git add -f`, like upstream's own `.claude/skills`. A new file under `.claude/` needs `git add -f` as well.

## One-time steps on GitHub and claude.ai

1. **Actions in this fork**: check Settings → Actions. Upstream's workflows are made for upstream. `pr-retarget-dev.yml` would move pull requests against `main` onto a `dev` branch that does not exist here, and `dev-images.yml`, `sync-helm-chart-tags.yml` and the NPM publish workflows run on pushes to `main`. Either keep Actions off, or disable these workflows individually in the Actions tab. Do not delete them in the repo, that only creates merge conflicts.
2. **Protect `main`**: require a pull request, no required approvals (you work alone), no force pushes. The GitHub proxy of a cloud session only blocks branch deletion and tag pushes, not pushes to existing branches. The deny rules in `settings.json` are an extra latch, not a boundary.
3. **Create the cloud environment** from `environment-settings.md` and `setup-script.sh`.
4. **First session** in that environment, with this prompt:
   > Check the environment: node and npm versions, is MongoDB running, does `.env` exist. Then run `/verify` on the current state of `main`. Report what fails and why, and do not change any code.

## Local

You need Node 24 (`.nvmrc`) and Docker:

```sh
bash .claude/scripts/bootstrap-env.sh
bash .claude/scripts/dev-services.sh up
npm ci && npm run build:packages
npm run backend:dev
```

## How it fits together

- **Setup script** (once per environment, cached): installs the Node version from `.nvmrc` next to the preinstalled ones and pre-pulls the MongoDB image.
- **SessionStart hook** (every session): puts Node on `PATH`, creates `.env`, starts MongoDB, runs `npm ci` and `npm run build:packages`. It does nothing locally.
- **Git as you**: pushes go through your GitHub connection (credentials stay outside the VM). Commit author and email come from the `GIT_*` variables. Claude also adds a `Claude-Session` trailer to commits; `attribution.sessionUrl: false` turns that off.
- **Cost**: the VM costs nothing extra, but usage counts against your Max limits. `npm ci`, builds and tests are shell commands and use little. Long debugging and parallel sessions use a lot.

## Not tested yet

Checked against the docs and the repo's files only, not in a real cloud session. Watch these on the first run:

- Docker in the setup script: it is not documented whether the daemon can start there. If pre-pulling fails, the hook pulls the image on first use.
- Extra network domains: found in the `package.json` files. Other downloads, such as Playwright browsers, are not covered.
- Runtime of the first hook: `npm ci` plus building the workspace packages can take several minutes (the hook has 10). `node_modules` is not part of the environment cache, so every new session repeats it.
- Node version: `.nvmrc` says 24.16.0 and the setup script installs that. npm 11.16.0 comes from the LibreChat docs, `package.json` pins `npm@11.13.0`.
