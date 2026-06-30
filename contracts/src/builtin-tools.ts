// The SINGLE canonical registry of built-in tool NAMES and their permission
// categories. A built-in's name is the policy stack's join key: classifyTool +
// permission-mode category sets + worker-definition allow/deny + editRegex all
// match on the BARE canonical name (Bash / Write / Read / …), so a wrong name is
// a SILENT capability escape (05 §4.1 / §5b). Centralizing the names here makes
// that mistake unrepresentable: permission-mode.ts builds its category sets from
// these arrays, tool-scope.ts pins Task from this enum, and the in-process
// BuiltinToolRegistry authors every tool under BUILTIN_TOOL_NAMES.* — one source
// of truth, no string literals scattered across layers.

export const BUILTIN_TOOL_NAMES = {
  Read: "Read",
  Write: "Write",
  Edit: "Edit",
  MultiEdit: "MultiEdit",
  NotebookEdit: "NotebookEdit",
  Bash: "Bash",
  BashOutput: "BashOutput",
  // Both spellings route to the shell category (the bundled binary has shipped
  // both over time); the registry authors KillShell, permission-mode keeps both.
  KillShell: "KillShell",
  KillBash: "KillBash",
  Glob: "Glob",
  Grep: "Grep",
  LS: "LS",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  TodoWrite: "TodoWrite",
  Task: "Task",
  ExitPlanMode: "ExitPlanMode",
} as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[keyof typeof BUILTIN_TOOL_NAMES];

// Category groupings — the SSOT for permission-mode classification. Mirrors the
// ToolCategory split in core/domain/permission-mode.ts; that file imports these so
// a renamed/typo'd tool can never silently fall into the wrong verdict bucket.
export const FILE_EDIT_BUILTIN_TOOLS = [
  BUILTIN_TOOL_NAMES.Edit,
  BUILTIN_TOOL_NAMES.Write,
  BUILTIN_TOOL_NAMES.MultiEdit,
  BUILTIN_TOOL_NAMES.NotebookEdit,
] as const;

export const SHELL_BUILTIN_TOOLS = [
  BUILTIN_TOOL_NAMES.Bash,
  BUILTIN_TOOL_NAMES.BashOutput,
  BUILTIN_TOOL_NAMES.KillBash,
  BUILTIN_TOOL_NAMES.KillShell,
] as const;

export const READ_BUILTIN_TOOLS = [
  BUILTIN_TOOL_NAMES.Read,
  BUILTIN_TOOL_NAMES.Glob,
  BUILTIN_TOOL_NAMES.Grep,
  BUILTIN_TOOL_NAMES.LS,
] as const;

export const NETWORK_BUILTIN_TOOLS = [
  BUILTIN_TOOL_NAMES.WebFetch,
  BUILTIN_TOOL_NAMES.WebSearch,
] as const;
