#!/usr/bin/env bash
# Fork-only: merges upstream's main into the sync branch and opens or updates the sync pull
# request. When the merge conflicts or the push is refused, opens or updates an issue instead.
# Run by .github/workflows/upstream-sync.yml from a full-history checkout of the fork.
#
# Env: GH_TOKEN, GITHUB_REPOSITORY (owner/repo of the fork), USING_PAT (true when a personal
# token pushes, so CI starts on the PR), UPSTREAM_REPO (default LibreChat-AI/LibreChat),
# UPSTREAM_BRANCH (default main), BASE (default main), BRANCH (default sync/upstream), DRY_RUN (print GitHub writes instead).
# Backticks in the single-quoted texts are Markdown, not expansions; sed keeps the lists short.
# shellcheck disable=SC2016,SC2001
set -euo pipefail

upstream_repo=${UPSTREAM_REPO:-LibreChat-AI/LibreChat}
upstream_branch=${UPSTREAM_BRANCH:-main}
base=${BASE:-main}
branch=${BRANCH:-sync/upstream}
issue_title='Upstream sync needs attention'
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}

# GitHub writes go through these, so a dry run changes nothing outside the clone.
gh_write() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN gh $*" >&2; else gh "$@"; fi; }
gh_read() { if [ -n "${DRY_RUN:-}" ]; then echo ''; else gh "$@"; fi; }

git remote get-url upstream >/dev/null 2>&1 ||
  git remote add upstream "https://github.com/${upstream_repo}.git"
git fetch --no-tags upstream "+refs/heads/${upstream_branch}:refs/remotes/upstream/main"
git fetch --no-tags origin "+refs/heads/${base}:refs/remotes/origin/${base}"

upstream_sha=$(git rev-parse upstream/main)
short=${upstream_sha:0:7}

if git merge-base --is-ancestor upstream/main "origin/${base}"; then
  echo "${base} already contains upstream main ${short}."
  exit 0
fi

pr=$(gh_read pr list --repo "$repo" --head "$branch" --base "$base" --state open \
  --json number --jq '.[0].number // empty')

# An open sync PR keeps its branch, so conflict fixes pushed to it survive the next run.
if [ -n "$pr" ]; then
  git fetch --no-tags origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"
  git checkout -q -B "$branch" "origin/${branch}"
  if git merge-base --is-ancestor upstream/main HEAD; then
    echo "Sync PR #${pr} already contains upstream main ${short}."
    exit 0
  fi
else
  git checkout -q -B "$branch" "origin/${base}"
fi

fork_base=$(git merge-base "origin/${base}" upstream/main)
new_commits=$(git rev-list --count "origin/${base}..upstream/main")
# Files both the fork and upstream changed since the last sync: merged, but worth a look.
overlap=$(comm -12 \
  <(git diff --name-only "$fork_base" "origin/${base}" | sort) \
  <(git diff --name-only "$fork_base" upstream/main | sort))

open_issue() {
  gh_read issue list --repo "$repo" --state open --search "in:title \"${issue_title}\"" \
    --json number,title --jq ".[] | select(.title == \"${issue_title}\") | .number" | head -n1
}

report_issue() {
  local body_file=$1 number
  number=$(open_issue)
  if [ -n "$number" ]; then
    gh_write issue comment "$number" --repo "$repo" --body-file "$body_file"
  else
    gh_write issue create --repo "$repo" --title "$issue_title" --body-file "$body_file"
  fi
}

body=$(mktemp)

if ! git merge --no-ff --no-edit -m "Merge upstream main (${short})" upstream/main >/dev/null; then
  conflicts=$(git diff --name-only --diff-filter=U)
  git merge --abort
  {
    echo "Merging upstream \`main\` (${upstream_repo}@${short}, ${new_commits} new commits) into \`${branch}\` conflicts in:"
    echo
    sed 's/.*/- `&`/' <<<"$conflicts"
    echo
    echo "Resolve it by hand on \`${branch}\`: start from \`origin/${branch}\` while the sync pull request is open, otherwise from \`origin/${base}\`; run \`git merge upstream/main\`, fix the files, push \`${branch}\` and open the pull request against \`${base}\` if there is none. The next run keeps that branch."
  } >"$body"
  cat "$body"
  report_issue "$body"
  exit 1
fi

push_args=(origin "HEAD:refs/heads/${branch}")
[ -z "$pr" ] && push_args=(--force "${push_args[@]}")
if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN git push ${push_args[*]}" >&2
elif ! git push "${push_args[@]}"; then
  {
    echo "The merge of upstream \`main\` (${upstream_repo}@${short}) succeeded, but pushing \`${branch}\` was refused."
    echo
    echo 'When upstream changed files under `.github/workflows`, only a token with the Workflows permission may push them; the built-in `GITHUB_TOKEN` never can. Add the `UPSTREAM_SYNC_TOKEN` secret described in `.github/workflows/upstream-sync.yml` and run the workflow again.'
  } >"$body"
  report_issue "$body"
  exit 1
fi

{
  echo "Merges upstream \`main\` (${upstream_repo}@${short}): ${new_commits} new commits, [compare](https://github.com/${upstream_repo}/compare/${fork_base:0:7}...${short})."
  echo
  echo '**Merge this pull request with a merge commit**, never squash or rebase: the merge commit is what tells the next sync which upstream commits are already in.'
  if [ -n "$overlap" ]; then
    echo
    echo 'Merged without conflicts, but changed on both sides since the last sync, so check them:'
    echo
    sed 's/.*/- `&`/' <<<"$overlap"
  fi
  if [ "${USING_PAT:-}" != 'true' ]; then
    echo
    echo 'Opened with the built-in `GITHUB_TOKEN`, so CI did not start on its own. Close and reopen this pull request to run it, or add the `UPSTREAM_SYNC_TOKEN` secret.'
  fi
} >"$body"
cat "$body"

title="chore: sync upstream main (${short})"
if [ -n "$pr" ]; then
  gh_write pr edit "$pr" --repo "$repo" --title "$title" --body-file "$body"
else
  gh_write pr create --repo "$repo" --base "$base" --head "$branch" --title "$title" --body-file "$body"
fi

issue=$(open_issue)
if [ -n "$issue" ]; then
  gh_write issue close "$issue" --repo "$repo" --comment "Resolved: upstream main ${short} merged into \`${branch}\` without problems."
fi
