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

## Tested in a cloud session

Confirmed in a real cloud session (2026-10-19, `main` at `9008c47`, 4 vCPU / 16 GB):

- Node 24.16.0 and npm 11.16.0 are on `PATH` (`package.json` still pins `npm@11.13.0`, which caused no problem).
- The SessionStart hook creates `.env`, starts MongoDB on 127.0.0.1:27017, and runs `npm ci` and `npm run build:packages`. It took about 1 min 50 s (`/tmp/cloud-session-start.log` from 11:33:22 to 11:35:13 UTC, `npm ci` about 1 min of that), well inside its 10 minutes.
- `npx tsc --noEmit` is clean in `packages/data-provider` (8 s), `packages/data-schemas` (27 s), `packages/api` (69 s), `packages/client` (7 s), `packages/chat` (5 s) and `client` (79 s). `api` has no tsconfig.
- Tests: `test:packages:data-provider` (14 s), `test:packages:data-schemas` (147 s), `test:packages:chat` (21 s) and `test:client` (744 s, 12097 tests) pass. Running all suites one after another took about 31 minutes and never ran short of memory.
- Network: `mongodb-memory-server` downloaded MongoDB 8.2.1 (122 MB) through the allowed `fastdl.mongodb.org`. No other domain was missing for typechecks and unit tests.

Known failures that come from the cloud VM, not from a code change:

- **Proxy variables.** The VM sets `HTTPS_PROXY`/`https_proxy` for its egress proxy. LibreChat reads them (`packages/api/src/utils/proxy.ts`) and builds a proxy dispatcher that several tests do not expect: 29 tests in `packages/api` (`src/endpoints/openai/config*.spec.ts`, `src/files/mistral/crud.spec.ts`) and 5 in `api` (`app/clients/tools/structured/specs/imageTools-agent.spec.js`, whose `undici` mock lacks `EnvHttpProxyAgent`). They pass when run with `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy`. `NO_PROXY='*'` does not help. Unset the variables only for the test run; downloads (npm, the MongoDB binary on first use) need the proxy.
- **LibreOffice.** The VM image has `soffice` on `PATH`, so the integration block in `packages/api/src/files/documents/libreoffice.spec.ts` runs instead of skipping. Its 3 tests then fail because in-process conversion is switched off in code (`IN_PROCESS_LIBREOFFICE_DISABLED = true`). Upstream CI has no LibreOffice, so it never sees this.

Still not tested:

- Docker in the setup script (pre-pulling the MongoDB image). MongoDB was running when the session started, but the log does not show whether the image came from the setup script cache or from the hook.
- Other downloads, such as Playwright browsers. Lighthouse and Playwright e2e are not set up here.
