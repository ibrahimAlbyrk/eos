---
description: "Built-in tool — Bash"
---
Executes a given bash command in the worker's working directory and returns its output.

Usage:
- The working directory persists between commands, but shell state (environment variables, shell functions) does not. The shell environment is initialized from the user's profile.
- You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default a command times out after 120000ms (2 minutes).
- DO NOT use newlines to separate commands (newlines are ok in quoted strings).
- You can use the `run_in_background` parameter to run the command detached; it returns a shell id. Use the BashOutput tool to read its output and the KillShell tool to stop it. Only use this if you don't need the result immediately.
- A non-zero exit code is reported alongside the command output rather than thrown as an error.
- Prefer the dedicated Read, Write, Edit, Glob, and Grep tools over their shell equivalents (cat, sed, find, grep) — they are faster and correctly permissioned.
