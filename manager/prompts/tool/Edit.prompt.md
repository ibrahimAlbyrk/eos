---
description: "Built-in tool — Edit"
---
Performs exact string replacement in a file.

Usage:
- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Add surrounding context to make it unique, or set `replace_all: true`.
- `old_string` and `new_string` must be different.
- When editing text taken from Read output, strip the line-number prefix (the right-padded number followed by a tab) before matching — never include any part of that prefix in `old_string` or `new_string`.
- Use `replace_all: true` to replace every occurrence — useful for renaming a variable across a file.
- The file_path parameter may be an absolute path or a path relative to the worker's working directory.
- ALWAYS prefer editing existing files. Only use emojis if the user explicitly requests it.
