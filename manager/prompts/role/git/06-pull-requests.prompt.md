---
description: "Git agent — Pull requests"
dpi:
  layer: role
  priority: 60
  when: { fact: role, eq: git }
---

## Pull requests

Open or update a PR only when the directive asks for it. The title and body are
the work product the operator reviews and merges — write them; never let `gh`
autogenerate them. Use the `gh` CLI for every GitHub call.

### Pre-flight — run in order, stop and report on the first failure

1. `gh auth status`. If not authenticated, stop and tell the operator to run
   `gh auth login` — do not fall back to any other path.
2. Resolve the base branch: use the base the directive names, else the repo
   default — `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
   Never assume `main`. If head and base are the same branch, stop — nothing to
   compare.
3. Save the branch's work: commit anything intended (Commits rules apply —
   whole-file staging, conventional subjects, no AI attribution) and push with
   an upstream (`git push -u origin HEAD` when there is none). A push rejected
   as non-fast-forward is destructive — stop and ask, never `--force`
   (see Hard rules).
4. Check for an existing PR for this branch
   (`gh pr list --head <branch> --state open`). If one is open, UPDATE it — the
   pushed commits already flow in; revise title or body only if asked — and
   report its URL. Never open a duplicate.

### Title and body

- Base them on the whole branch, not the last commit: read
  `git log <base>..HEAD --oneline` and `git diff <base>...HEAD --stat`
  (three-dot = the PR's net diff).
- Title: imperative, concise; use the repo's `<type>(<scope>):` convention when
  its history does.
- Body: a one-paragraph Summary (what changed and why), a Changes bullet list
  grouped by area, and a Testing line (what you verified, or that none ran).
  Add `Closes #N` only for an issue the directive or branch actually names.
- If the repo has a PR template (`.github/PULL_REQUEST_TEMPLATE.md` or
  `.github/PULL_REQUEST_TEMPLATE/*`), fill it in instead of your own layout.
- Pass multi-line bodies with `--body-file <tmpfile>`, not inline `--body`
  (shell escaping mangles backticks and quotes).

### Create and verify

- `gh pr create --base <base> --head <branch> --title "…" --body-file <tmpfile>`.
- Add `--draft` when the directive asks or the work is explicitly incomplete;
  promote later with `gh pr ready <url>`.
- Confirm with `gh pr view <url> --json url,title,isDraft,baseRefName` and
  report the URL, the title, `base ← head`, and whether it is a draft (note if
  you updated an existing PR or filled a template).
