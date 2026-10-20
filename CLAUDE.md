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
- `.github/workflows/upstream-sync.yml` does this every Monday and opens a `sync/upstream` pull request, or an issue "Upstream sync needs attention" on a conflict. Merge sync pull requests with a merge commit, never squash or rebase, or the next sync cannot tell which upstream commits are already in. Cloud sessions can fetch upstream (public, read-only), so a conflict can be resolved there on `sync/upstream`.

## Platform plan

This fork is the base of a multi-tenant platform. The architecture, repositories, roadmap and open
decisions are in `docs/platform/architecture.md`. Read it before platform work and update it when a
decision changes.

## Customizations

Record every deliberate deviation from upstream here, one line each, so merges and conflicts stay explainable.

- `.github/workflows/fork-image.yml` (fork-only): on pushes to `main` (same `paths` as `dev-images.yml`) and on manual dispatch, builds `Dockerfile` target `node` for `linux/amd64` and pushes `ghcr.io/<owner>/librechat:latest` and `:sha-<short>` with `GITHUB_TOKEN` only, no Docker Hub.
- Tenant-aware OpenID (`packages/api/src/auth/openid/tenant.ts`, wired in `api/strategies/openidStrategy.js`, `api/strategies/openIdJwtStrategy.js`, `api/server/routes/oauth.js`, `api/server/controllers/auth/oauth.js`, `api/server/middleware/oauthNavigation.js`): optional `TENANT_DOMAIN_SERVER`, `TENANT_DOMAIN_CLIENT`, `OPENID_TENANT_SCOPE` and `OPENID_TENANT_CLAIM` give each tenant its own callback and redirect URLs, provider scopes, and a claim that must match the request tenant. The `openidJwt` strategy (`OPENID_REUSE_TOKENS`) checks the claim too and, with `TRUST_TENANT_HEADER`, looks the user up in the proxy's tenant. The admin login (`/api/admin/oauth/openid`, `api/server/routes/admin/auth.js`) is tenant-aware the same way, and `OPENID_ADMIN_ROLE` also matches role claims shaped as objects keyed by role (Zitadel, `packages/api/src/auth/openid/roles.ts`). Unset, behaviour is upstream's.
- `.github/workflows/upstream-sync.yml` and `.github/scripts/upstream-sync.sh` (fork-only): weekly merge of upstream `main` into `sync/upstream` with a pull request against `main`; conflicts and refused pushes open an issue. Optional secret `UPSTREAM_SYNC_TOKEN` (fine-grained PAT: Contents, Pull requests, Issues, Workflows read and write) lets CI run on the pull request and lets merges that touch upstream workflows be pushed.
- Tenant host check (`packages/api/src/middleware/tenant.ts`): with `TRUST_TENANT_HEADER=true` and the optional `TENANT_HEADER_MATCH_USER=true`, an authenticated request whose user belongs to another tenant than the proxy's `X-Tenant-Id` gets 403. Unset, behaviour is upstream's.
- Admin user deletion (`packages/api/src/admin/deletion.ts`, routed in `api/server/routes/admin/users.js`): with `ADMIN_USER_DELETION=true`, upstream's existing admin erasure handler is reachable as `DELETE /api/admin/users/:id` (capability `MANAGE_USERS`, within the admin's tenant). Unset, the route answers 404 as upstream leaves it unrouted.
- Admin balance API (`packages/api/src/admin/balance.ts`, routed in `api/server/routes/admin/users.js`, audit action `user.balance_updated` in `packages/data-schemas/src/types/admin.ts`): `GET` (`READ_USERS`) and `PUT` (`MANAGE_USERS`) `/api/admin/users/:id/balance` read and set the credit balance of a user in the admin's tenant; upstream sets balances only through `config/set-balance.js`.
- Model catalog lock (`packages/api/src/admin/catalog.ts`, checked in the PUT and PATCH handlers of `packages/api/src/admin/config.ts`, switched in `api/server/routes/admin/config.js`): with `ADMIN_CONFIG_CATALOG_LOCK=true`, admin config writes may set `endpoints` only to narrow `librechat.yaml`'s custom endpoints (`name` plus `models.default` from the catalog list) and may not reference environment variables anywhere. Unset, behaviour is upstream's.
- MCP call context (`packages/api/src/mcp/callContext.ts`, schema field in `packages/data-provider/src/mcp.ts`, wired in `packages/api/src/mcp/MCPManager.ts` and `api/server/services/MCP.js`): an admin-defined MCP server with `callContext: true` receives the turn's model, saved agent id, conversation id and message id in each `tools/call` request's `_meta` under `librechat/context`. Unset, behaviour is upstream's.
- Custom domains (`packages/api/src/middleware/tenantOrigin.ts`, read in `getTenantDomains` of `packages/api/src/auth/openid/tenant.ts`, mounted in `api/server/index.js` and `api/server/experimental.js`): with `TRUST_TENANT_HEADER=true`, a request whose trusted proxy sends `X-Tenant-Origin` (an http(s) origin) uses that origin as the tenant's client and server URL (OpenID callback, redirects, `serverDomain`) instead of the `TENANT_DOMAIN_*` templates. Unset, behaviour is upstream's.

## Environment

- Node 24.16.0 (see `.nvmrc`) and npm 11. MongoDB is required.
- Local setup: `bash .claude/scripts/bootstrap-env.sh` (creates `.env` with fresh dev secrets), `bash .claude/scripts/dev-services.sh up` (MongoDB in Docker), `npm ci`, `npm run build:packages`, then `npm run backend:dev` and `npm run frontend:dev`.
- Cloud sessions do the same automatically through the SessionStart hook (`.claude/scripts/cloud-session-start.sh`). The environment itself is set up as described in `.claude/cloud-environment/README.md`.
- Never read or print `.env`.
- `api` and `data-schemas` tests use `mongodb-memory-server`, which downloads a MongoDB binary on first run. If that fails in a cloud session, it is a network allowlist problem, not a code bug.
- Lighthouse and Playwright e2e are not set up in cloud sessions. Run them only when asked, and when `AGENTS.md` requires one that you cannot run, say so in your report.
- Upstream's `.gitignore` ignores `/.claude/` and `CLAUDE.md` (only `.claude/skills` is tracked, force-added). The files here were added the same way, so a new file under `.claude/` needs `git add -f`.
- The cloud VM has about 4 vCPU and 16 GB RAM. The client build can use up to 8 GB of heap, so do not run it in parallel with the full test suites.
