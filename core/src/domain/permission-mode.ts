// Permission-mode semantics — pure domain. Maps each PermissionMode literal
// to a verdict table over tool categories. The PolicyGatewayService consults
// this when no explicit policy.yaml rule fires.
//
// Design: Strategy pattern per mode. Adding a new mode is data-only — drop
// a new entry into MODE_SPECS, no decider changes.

import type { PermissionMode } from "../../../contracts/src/worker.ts";
import {
  FILE_EDIT_BUILTIN_TOOLS,
  SHELL_BUILTIN_TOOLS,
  READ_BUILTIN_TOOLS,
  NETWORK_BUILTIN_TOOLS,
} from "../../../contracts/src/builtin-tools.ts";

export type { PermissionMode };

export type ToolCategory =
  | "fileEdit"   // Edit, Write, MultiEdit, NotebookEdit
  | "planFile"   // fileEdit targeting the Claude plans dir (~/.claude/plans) — plan artifact, always allowed
  | "shell"      // Bash, BashOutput, KillBash
  | "read"       // Read, Glob, Grep, LS
  | "mcp"        // Any mcp__* tool — infrastructure, always allowed
  | "network"    // WebFetch, WebSearch
  | "other";     // Everything else — Task, TodoWrite, AskUserQuestion, etc.

export type Verdict = "allow" | "ask" | "deny";

export interface ModeSpec {
  readonly mode: PermissionMode;
  readonly decide: (category: ToolCategory) => Verdict;
}

// Category sets are built from the canonical name registry (contracts) so a
// tool's category can never drift from its name across layers.
const FILE_EDIT_TOOLS = new Set<string>(FILE_EDIT_BUILTIN_TOOLS);
const SHELL_TOOLS = new Set<string>(SHELL_BUILTIN_TOOLS);
const READ_TOOLS = new Set<string>(READ_BUILTIN_TOOLS);
const NETWORK_TOOLS = new Set<string>(NETWORK_BUILTIN_TOOLS);

// Pure segment-level resolution (core can't use node:path). Resolves "."/".."
// so a traversal like plans/../../etc can't spoof the prefix check. Symlinks
// are NOT resolved — creating one inside plansDir already requires write
// access, so that escape is outside the threat model.
function resolveSegments(p: string): string[] | null {
  if (!p.startsWith("/")) return null;
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return out;
}

export function isPathInside(child: string, parent: string): boolean {
  const c = resolveSegments(child);
  const p = resolveSegments(parent);
  if (!c || !p) return false;
  if (c.length <= p.length) return false;
  return p.every((seg, i) => c[i] === seg);
}

export function classifyTool(
  toolName: string,
  input?: Record<string, unknown>,
  plansDir?: string,
): ToolCategory {
  if (toolName.startsWith("mcp__")) return "mcp";
  if (FILE_EDIT_TOOLS.has(toolName)) {
    if (plansDir && input) {
      const target = input.file_path ?? input.notebook_path;
      if (typeof target === "string" && isPathInside(target, plansDir)) return "planFile";
    }
    return "fileEdit";
  }
  if (SHELL_TOOLS.has(toolName)) return "shell";
  if (READ_TOOLS.has(toolName)) return "read";
  if (NETWORK_TOOLS.has(toolName)) return "network";
  return "other";
}

// Per-mode verdict table. Read + MCP + planFile are always allowed across
// modes — MCP because it's orchestration plumbing, read because it never
// mutates, planFile because writing the plan artifact IS the planning work.
// `acceptEdits` waves through file writes but still asks for shell/network;
// `bypassPermissions` (shown as "Full Access" in the UI) opens the floodgates.
export const MODE_SPECS: Record<PermissionMode, ModeSpec> = {
  acceptEdits: {
    mode: "acceptEdits",
    decide(category) {
      if (category === "mcp" || category === "read" || category === "planFile") return "allow";
      if (category === "fileEdit") return "allow";
      return "ask";
    },
  },
  bypassPermissions: {
    mode: "bypassPermissions",
    decide() {
      return "allow";
    },
  },
};
