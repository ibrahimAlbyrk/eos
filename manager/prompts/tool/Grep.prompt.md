---
description: "Built-in tool — Grep"
---
A powerful search tool built on ripgrep.

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command — the Grep tool is optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\s+\w+").
- Filter files with the `glob` parameter (e.g., "*.js", "**/*.tsx") or the `type` parameter (e.g., "js", "py", "rust").
- Output modes: `content` shows matching lines, `files_with_matches` shows only file paths (default), `count` shows match counts.
- Use `-i` for case-insensitive search and `-n` to show line numbers in content mode. Use `head_limit` to cap the number of output lines.
- Use the Task tool for open-ended searches requiring multiple rounds.
- Pattern syntax uses ripgrep (not grep): literal braces need escaping (use `interface\{\}` to find `interface` followed by empty braces in Go code).
