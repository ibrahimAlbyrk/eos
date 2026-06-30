// NotebookEdit — edit a single cell of a Jupyter .ipynb notebook (JSON). Canonical
// fields: notebook_path, new_source, cell_id?, cell_type?, edit_mode? (replace|
// insert|delete). A minimal but faithful cell editor: locate by cell id, set its
// source, or insert/delete a cell.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ToolFileSystem } from "../../../../core/src/ports/ToolFileSystem.ts";
import { resolveToolPath, requireString } from "./_shared.ts";

interface NotebookCell {
  id?: string;
  cell_type?: string;
  source?: unknown;
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

export function createNotebookEditTool(fs: ToolFileSystem): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.NotebookEdit,
    schema: {
      type: "object",
      properties: {
        notebook_path: { type: "string", description: "Absolute or cwd-relative path to the .ipynb file." },
        new_source: { type: "string", description: "The new cell source." },
        cell_id: { type: "string", description: "Target cell id (required for replace/delete)." },
        cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type (for insert)." },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "Default replace." },
      },
      required: ["notebook_path", "new_source"],
    },
    async execute(input, ctx) {
      const path = resolveToolPath(ctx, input.notebook_path);
      const newSource = requireString(input, "new_source");
      const cellId = typeof input.cell_id === "string" ? input.cell_id : undefined;
      const editMode = typeof input.edit_mode === "string" ? input.edit_mode : "replace";
      const cellType = typeof input.cell_type === "string" ? input.cell_type : "code";

      const raw = await fs.readFile(path);
      let nb: { cells?: NotebookCell[] };
      try {
        nb = JSON.parse(raw);
      } catch {
        throw new Error("notebook is not valid JSON");
      }
      const cells = Array.isArray(nb.cells) ? nb.cells : (nb.cells = []);
      const indexOfId = cellId ? cells.findIndex((c) => c.id === cellId) : -1;

      if (editMode === "insert") {
        const cell: NotebookCell = { id: cellId, cell_type: cellType, source: newSource, metadata: {} };
        if (cellType === "code") { cell.outputs = []; cell.execution_count = null; }
        cells.splice(indexOfId >= 0 ? indexOfId + 1 : 0, 0, cell);
      } else if (editMode === "delete") {
        if (indexOfId < 0) throw new Error("cell_id not found for delete");
        cells.splice(indexOfId, 1);
      } else {
        if (indexOfId < 0) throw new Error("cell_id not found for replace");
        cells[indexOfId].source = newSource;
        if (cellType && cells[indexOfId].cell_type !== cellType) cells[indexOfId].cell_type = cellType;
      }
      await fs.writeFile(path, JSON.stringify(nb, null, 1) + "\n");
      return `Notebook ${editMode} applied to ${path}`;
    },
  };
}
