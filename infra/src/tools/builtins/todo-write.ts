// TodoWrite — the model's in-loop task list. There is no Eos-side todo store on
// this lane (the list is the model's own working memory); the tool validates the
// payload and echoes a compact confirmation so the model can track its plan across
// turns, matching the bundled binary's surface. Canonical field: todos[].

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";

interface Todo {
  content?: string;
  status?: string;
  activeForm?: string;
}

export function createTodoWriteTool(): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.TodoWrite,
    description: "Create or update the working task list (todos). Use to track multi-step work.",
    schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(input) {
      const todos = input.todos;
      if (!Array.isArray(todos)) throw new Error("'todos' must be an array");
      const counts = { pending: 0, in_progress: 0, completed: 0 } as Record<string, number>;
      for (const t of todos as Todo[]) {
        const s = typeof t.status === "string" ? t.status : "pending";
        counts[s] = (counts[s] ?? 0) + 1;
      }
      return `Todos updated: ${todos.length} item(s) (${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending).`;
    },
  };
}
