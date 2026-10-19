@AGENTS.md

# Fork overrides

This is `anno-systems/LibreChat`, a solo-maintained fork of `LibreChat-AI/LibreChat`. Everything in `AGENTS.md` applies unchanged **except** what this section replaces. Where the two disagree, this section wins. `AGENTS.md` is upstream's file and is never edited in this fork, so upstream merges stay clean.

## Branching and pull requests (replaces the dev/canary rules in AGENTS.md)

- This fork has only `main`. Branch from `main` and open pull requests against `main`. Ignore everything in `AGENTS.md` about `dev`, `canary`, `--base dev`, `--base canary`, the main-to-dev retarget workflow and the `target: main` label.
- Work done by Claude goes on a branch named `claude/<short-topic>`. Never push to `main` directly. The owner reviews and merges the pull request.
- Closing keywords such as `Fixes #N` work here, because `main` is the default branch.
- Reproduce the PR's static checks with `npm run static-checks -- --against origin/main` (use `static-checks:full` for the slower gates).
- In cloud sessions, `gh pr` and `gh issue` do not work (the GitHub proxy blocks GraphQL). Use the built-in GitHub tools for pull requests and issues.
- The review, completion, verification, module-boundary, style and testing rules of `AGENTS.md` all still apply. `/verify` runs the verification part.

## Staying close to upstream

- Prefer additive changes (new modules, new files, config) over rewriting upstream code. No drive-by reformatting, renames or refactors in files we do not otherwise change.
- Do not edit upstream's `.github/workflows`. Workflows this fork does not want are disabled in GitHub's Actions settings instead.
- Update from upstream with a merge, not a rebase: `git remote add upstream https://github.com/LibreChat-AI/LibreChat.git`, `git fetch upstream main`, `git merge upstream/main`. Upstream's `main` is a pointer to a tested `dev` commit.
- Pulling upstream happens locally. Cloud sessions only reach the repository attached to them.

## Platform plan

This fork is the base of a multi-tenant platform. The architecture, repositories, roadmap and open
decisions are in `docs/platform/architecture.md`. Read it before platform work and update it when a
decision changes.

## Customizations

Record every deliberate deviation from upstream here, one line each, so merges and conflicts stay explainable.

- `.github/workflows/fork-image.yml` (fork-only): on pushes to `main` (same `paths` as `dev-images.yml`) and on manual dispatch, builds `Dockerfile` target `node` for `linux/amd64` and pushes `ghcr.io/<owner>/librechat:latest` and `:sha-<short>` with `GITHUB_TOKEN` only, no Docker Hub.

## Environment

- Node 24.16.0 (see `.nvmrc`) and npm 11. MongoDB is required.
- Local setup: `bash .claude/scripts/bootstrap-env.sh` (creates `.env` with fresh dev secrets), `bash .claude/scripts/dev-services.sh up` (MongoDB in Docker), `npm ci`, `npm run build:packages`, then `npm run backend:dev` and `npm run frontend:dev`.
- Cloud sessions do the same automatically through the SessionStart hook (`.claude/scripts/cloud-session-start.sh`). The environment itself is set up as described in `.claude/cloud-environment/README.md`.
- Never read or print `.env`.
- `api` and `data-schemas` tests use `mongodb-memory-server`, which downloads a MongoDB binary on first run. If that fails in a cloud session, it is a network allowlist problem, not a code bug.
- Lighthouse and Playwright e2e are not set up in cloud sessions. Run them only when asked, and when `AGENTS.md` requires one that you cannot run, say so in your report.
- Upstream's `.gitignore` ignores `/.claude/` and `CLAUDE.md` (only `.claude/skills` is tracked, force-added). The files here were added the same way, so a new file under `.claude/` needs `git add -f`.
- The cloud VM has about 4 vCPU and 16 GB RAM. The client build can use up to 8 GB of heap, so do not run it in parallel with the full test suites.
