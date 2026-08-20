---
description: "Built-in tool — Write"
---
Writes a file to the local filesystem.

Usage:
- The file_path parameter may be an absolute path or a path relative to the worker's working directory.
- This tool will overwrite the existing file if there is one at the provided path, and creates any missing parent directories.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- Don't add documentation files or emojis unless the user asked for them — default to code only.
