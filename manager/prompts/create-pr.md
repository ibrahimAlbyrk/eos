---
description: Create a pull request for the current branch
argument-hint: [draft: true|false]
---

# Purpose

Create a pull request for the current branch by following the `Instructions` and `Workflow`. Whether the PR is opened as a draft is controlled by `DRAFT`.

## Variables

DRAFT: $1

## Instructions

- Ensure all intended changes are committed and pushed before creating the PR.
- If leftover work needs committing, stage whole files — never split one file's changes across commits (`git add -p`).
- Write the PR title and body yourself: title in imperative mood, body summarizing what changed and why.
- Follow the repository's PR conventions (check existing PRs or a PR template if present).
- Use the `gh` CLI for all GitHub operations.
- If the branch has no upstream, push with `-u` first.

## Workflow

1. Run `git status` and `git log` to understand what this branch contains relative to the base branch.
2. Push the branch if the remote is not up to date.
3. Compose the PR title and body from the branch's commits.
4. If `DRAFT` is true, create the PR with `gh pr create --draft`; otherwise use `gh pr create`.

## Report

- State the PR URL.
- Summarize the title and scope in one line.
