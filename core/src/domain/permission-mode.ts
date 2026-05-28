// Permission-mode semantics — pure domain. Maps each PermissionMode literal
// to a verdict table over tool categories. The PolicyGatewayService consults
// this when no explicit policy.yaml rule fires.
//
// Design: Strategy pattern per mode. Adding a new mode is data-only — drop
// a new entry into MODE_SPECS, no decider changes.

import type { PermissionMode } from "../../../contracts/src/worker.ts";

export type { PermissionMode };

export type ToolCategory =
  | "fileEdit"   // Edit, Write, MultiEdit, NotebookEdit
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

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillBash", "KillShell"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

export function classifyTool(toolName: string): ToolCategory {
  if (toolName.startsWith("mcp__")) return "mcp";
  if (FILE_EDIT_TOOLS.has(toolName)) return "fileEdit";
  if (SHELL_TOOLS.has(toolName)) return "shell";
  if (READ_TOOLS.has(toolName)) return "read";
  if (NETWORK_TOOLS.has(toolName)) return "network";
  return "other";
}

// Per-mode verdict table. Read + MCP are always allowed across modes —
// MCP because it's orchestration plumbing, read because it never mutates.
// `plan` denies anything that could touch the world; `acceptEdits` waves
// through file writes; `bypassPermissions` opens the floodgates.
export const MODE_SPECS: Record<PermissionMode, ModeSpec> = {
  default: {
    mode: "default",
    decide(category) {
      if (category === "mcp" || category === "read") return "allow";
      return "ask";
    },
  },
  acceptEdits: {
    mode: "acceptEdits",
    decide(category) {
      if (category === "mcp" || category === "read") return "allow";
      if (category === "fileEdit") return "allow";
      return "ask";
    },
  },
  plan: {
    mode: "plan",
    decide(category) {
      if (category === "mcp" || category === "read") return "allow";
      if (category === "fileEdit" || category === "shell" || category === "network") return "deny";
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
