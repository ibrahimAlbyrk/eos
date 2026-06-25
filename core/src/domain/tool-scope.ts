// Re-exports the caller-scope guard from contracts/ so core and the spawner
// (which cannot import core) share the same single source of truth.

export {
  EOS_BUILTIN_MCP_SERVERS,
  isEosControlTool,
  BLOCKED_BUILTIN_TOOLS,
  blockedBuiltinToolMessage,
  isBlockedBuiltinTool,
} from "../../../contracts/src/tool-scope.ts";
export type { EosBuiltinMcpServer } from "../../../contracts/src/tool-scope.ts";
