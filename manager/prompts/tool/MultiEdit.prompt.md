---
description: "Built-in tool — MultiEdit"
---
Applies multiple exact string replacements to a single file in one atomic operation.

Usage:
- Provide `file_path` and an `edits` array; each edit has `old_string`, `new_string`, and an optional `replace_all`.
- Edits are applied sequentially, in order — each edit operates on the result of the previous one.
- The operation is atomic: if any edit fails (e.g. its `old_string` is missing or not unique), no changes are written to the file.
- Each `old_string` must match exactly and be unique within the current content unless `replace_all` is set, following the same rules as the Edit tool.
- Prefer MultiEdit over several separate Edit calls when changing one file in multiple places.
- The file_path parameter may be an absolute path or a path relative to the worker's working directory.
