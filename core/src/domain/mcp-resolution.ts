// Pure MCP-server composition policy. Given the servers claude would inherit
// for a worker's cwd, the per-agent filter config, and the system "built-in"
// servers (gateway / worker / orchestrator), produces the final server map
// plus a `strict` flag telling the spawner whether to pass --strict-mcp-config.
//
// Two modes, selected by the config (isFilterActive):
//   - additive (no filter): emit only extra + builtins and let claude discover
//     inherited servers itself (strict = false). This is what guarantees plain
//     "standard claude behavior + our extras", with zero discovery-replication
//     risk — claude loads every scope it normally would.
//   - strict (filter active): emit the fully composed map (filtered inherited +
//     extra + builtins) and isolate claude to exactly it (strict = true).
//
// builtins always win on name collision: the gateway/worker/orchestrator
// servers are infrastructure and must never be shadowed by an inherited or
// user-supplied server sharing their name.

export interface AgentMcpConfig {
  readonly inheritDefaults: boolean;
  readonly include: readonly string[]; // ["*"] = every inherited server
  readonly exclude: readonly string[];
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface ResolveMcpInput {
  inherited: Record<string, unknown>;
  builtins: Record<string, unknown>;
  config: AgentMcpConfig;
  // Lanes that cannot self-discover MCP scopes (claude-sdk runs with
  // settingSources:[], so the binary inherits nothing on its own). false →
  // ALWAYS materialize the filtered inherited set (strict), since the additive
  // shortcut relies on a native discovery that lane does not have and would
  // silently drop every inherited server. Default true = unchanged cli behavior.
  nativeDiscovery?: boolean;
}

export interface ResolvedMcp {
  servers: Record<string, unknown>;
  strict: boolean;
}

export function isFilterActive(config: AgentMcpConfig): boolean {
  return (
    !config.inheritDefaults ||
    !config.include.includes("*") ||
    config.exclude.length > 0
  );
}

function filterInherited(
  inherited: Record<string, unknown>,
  include: readonly string[],
  exclude: readonly string[],
): Record<string, unknown> {
  const includeAll = include.includes("*");
  const denied = new Set(exclude);
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(inherited)) {
    if (denied.has(name)) continue;
    if (!includeAll && !include.includes(name)) continue;
    out[name] = def;
  }
  return out;
}

export function resolveMcpServers(input: ResolveMcpInput): ResolvedMcp {
  const { inherited, builtins, config, nativeDiscovery = true } = input;
  if (!nativeDiscovery) {
    const base = config.inheritDefaults
      ? filterInherited(inherited, config.include, config.exclude)
      : {};
    return { servers: { ...base, ...config.extra, ...builtins }, strict: true };
  }
  if (!isFilterActive(config)) {
    return { servers: { ...config.extra, ...builtins }, strict: false };
  }
  const base = config.inheritDefaults
    ? filterInherited(inherited, config.include, config.exclude)
    : {};
  return { servers: { ...base, ...config.extra, ...builtins }, strict: true };
}
