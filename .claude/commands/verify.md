---
description: Verify the changed workspaces the way AGENTS.md requires and report what passed, failed or could not run
---

Verify the current branch before it goes into a pull request. Follow the "Verification" and "Testing" rules of `AGENTS.md`, with `main` as the base branch of this fork.

1. Find what changed: `git fetch origin main`, then `git diff --name-only origin/main...HEAD` plus uncommitted changes (`git status --short`). Map the paths to workspaces: `api`, `client`, `packages/api`, `packages/client`, `packages/chat`, `packages/data-provider`, `packages/data-schemas`.
2. Make sure MongoDB is up: `bash .claude/scripts/dev-services.sh up`. Build the workspace packages if they are not built yet: `npm run build:packages`.
3. For each changed workspace, and only those, run in this order and fix the first failure before moving on:
   - Typecheck in that workspace: `cd <workspace> && npx tsc --noEmit` (a green build is not a typecheck).
   - Its tests, run from the owning workspace through the root scripts: `npm run test:api`, `npm run test:client`, `npm run test:packages:api`, `npm run test:packages:data-provider`, `npm run test:packages:data-schemas`, `npm run test:packages:chat`. `packages/client` has no test script; typecheck and lint cover it.
4. Run `npm run sort-imports` with explicit paths of the files you touched. Never run it without arguments, it rewrites every source root.
5. Run `npm run static-checks -- --against origin/main`, and `npm run lint` when TypeScript or React files changed.
6. If a test fails, find the root cause first. Do not delete, skip or loosen a test to get green.
7. Report like `AGENTS.md` asks: what you ran, what passed, what failed and why, anything you could not run. Lighthouse and Playwright e2e cannot run in a cloud session. When the change touches startup, auth, config, file or message loading, say explicitly that `npm run lighthouse` was not run.
