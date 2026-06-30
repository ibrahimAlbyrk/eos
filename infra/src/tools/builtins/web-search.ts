// WebSearch — surface only. The bundled binary reaches a hosted search provider
// Eos does not configure on this lane; rather than invent one, the tool is present
// (so the model can attempt it and the policy stack governs it) but returns a clear
// "no search provider configured" error. v1 limitation — a provider can be injected
// later without changing the surface. Canonical field: query.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";

export function createWebSearchTool(): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.WebSearch,
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
    async execute() {
      throw new Error("WebSearch is unavailable: no search provider is configured for this lane (v1 limitation). Use WebFetch with a known URL instead.");
    },
  };
}
