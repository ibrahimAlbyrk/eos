// Port: discovers the MCP servers standard `claude` would load for a given
// cwd — user scope (~/.claude.json), project scope (.mcp.json), local scope —
// after applying the enable/disable filters claude itself honors. Returned
// keyed by server name. Implemented in infra (reads disk); core stays pure.
//
// Consulted ONLY when a per-agent MCP filter is active (strict mode). The
// additive path lets claude perform its own discovery, so fidelity gaps here
// (plugins, claude.ai connectors) never affect the unfiltered "inherit all"
// case — see core/src/domain/mcp-resolution.ts.
export interface McpServerCatalog {
  listInherited(cwd: string): Record<string, unknown>;
}
