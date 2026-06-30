---
description: "Built-in tool — Read"
---
Reads a file from the local filesystem and returns its contents with `cat -n` style line numbers (1-based).

Usage:
- The file_path parameter may be an absolute path or a path relative to the worker's working directory.
- By default it reads up to 2000 lines starting from the beginning of the file. Use the offset (1-based start line) and limit parameters to page through larger files.
- Each line is prefixed with its right-padded line number and a tab, matching the format of `cat -n`; the numbers stay absolute when offset/limit are used.
- It is okay to attempt to read a file that does not exist — an error will be returned.
- If you read a file that exists but is empty, you will receive an "(file is empty)" notice in place of contents.
- This tool reads text files only. To list the entries of a directory, use the LS tool.
