---
description: "Built-in tool — NotebookEdit"
---
Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file).

Usage:
- `notebook_path` may be an absolute path or a path relative to the worker's working directory.
- `cell_id` is the `id` of the target cell. It is required for `replace` and `delete`.
- `edit_mode` defaults to `replace`. Use `insert` to add a new cell after the cell with the given `cell_id` (or at the beginning of the notebook if `cell_id` is omitted) — `cell_type` is required when inserting. Use `delete` to remove the cell.
- `new_source` is the source for the cell being replaced or inserted.
