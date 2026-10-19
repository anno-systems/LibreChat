# Cloud environment values

Create it at claude.ai/code: environment selector below the message box → **New environment** → fill in the fields → **Add environment**.

## Name

`librechat`

## Network access: Custom

Tick **Also include default list of common package managers**. Under **Allowed domains** add:

```text
cdn.sheetjs.com
fastdl.mongodb.org
```

Why:
- `cdn.sheetjs.com`: `api/package.json` pulls `xlsx` as a tarball from there. Without it `npm ci` fails.
- `fastdl.mongodb.org`: `mongodb-memory-server` (api and data-schemas tests) downloads a MongoDB binary on first run. If tests still fail on a download error, the message names the missing host. Add it here.

Docker Hub (for the `mongo` image), npm and GitHub are in the default list.

## Environment variables

```text
GIT_AUTHOR_NAME=<your name>
GIT_COMMITTER_NAME=<your name>
GIT_AUTHOR_EMAIL=<id>+<github-user>@users.noreply.github.com
GIT_COMMITTER_EMAIL=<id>+<github-user>@users.noreply.github.com
BASH_DEFAULT_TIMEOUT_MS=600000
BASH_MAX_TIMEOUT_MS=600000
```

- The four `GIT_*` variables decide the author name and email of commits. Your noreply address is under GitHub → Settings → Emails, so your private address stays out of the git history of this public fork.
- The timeouts allow longer builds and test runs in the foreground (default is 2 minutes).
- Anyone who uses the environment can read these values. Do not put secrets here.

## Setup script

Paste the content of `setup-script.sh` from this folder.

## Optional: API keys for real chats

Builds and tests need no LLM keys. If Claude should test real chats against a provider in the cloud, add the key as a **network secret** (Bearer, allowed domain e.g. `api.openai.com`, plus that domain in the allowed list). The key then stays outside the VM, and LibreChat only gets a placeholder in `.env`.
