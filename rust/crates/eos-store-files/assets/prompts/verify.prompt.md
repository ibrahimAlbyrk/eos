---
description: Run the project's checks in YOUR working directory and report honest verdicts
---

# Purpose

Verify the current state of your work by running the project's own checks
(build, tests, lint) inside YOUR working directory, then report per-check
verdicts the operator can trust.

## Instructions

- Run checks in YOUR current working directory only — never in any other
  checkout.
- Detect the project's check commands yourself: package.json scripts
  (test/build/lint/typecheck), Makefile targets, or the repo's documented
  commands. Prefer the narrowest set that actually validates your changes.
- Verdict vocabulary (use these words exactly):
  - `passed` — the command ran and exited clean. Only after actually running it.
  - `failed` — the command ran and failed. Include the failing output's key lines.
  - `blocked` — you could not run it (missing dependency, missing config,
    denied permission). Name exactly what is missing. This is an honorable
    verdict — never fabricate a pass.
  - `flaky` — mixed results across re-runs.
- NEVER claim `passed` without running the command in this session. No
  inherited or assumed results.

## Workflow

1. Identify the check commands (build, then tests; lint/typecheck if cheap).
2. Run each, one at a time.
3. Report.

## Report

One line per check, exact format:

```
verify: <command> -> passed|failed|blocked|flaky [— one-line detail]
```

Then a final line:

```
Handover: branch <your branch, if any>; verified by <primary command>: <passed|failed|blocked|flaky|unverified>; to try: <command the operator would use>
```
