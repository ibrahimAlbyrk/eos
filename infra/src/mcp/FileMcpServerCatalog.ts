// Replicates the MCP servers standard `claude` discovers for a cwd, by scope
// precedence local > project > user. Two on-disk sources:
//   ~/.claude.json  → top-level `mcpServers` (user scope)
//                     projects[cwd].mcpServers (local scope)
//                     projects[cwd].{enabled,disabled}McpjsonServers (gates)
//   <cwd>/.mcp.json → `mcpServers` (project scope), gated by the lists above
//
// Plugin- and claude.ai-connector-scoped servers are NOT replicated. Callers
// needing full fidelity must stay in additive mode (no strict isolation) so
// claude does its own discovery — see core/src/domain/mcp-resolution.ts.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerCatalog } from "../../../core/src/ports/McpServerCatalog.ts";

type ServerMap = Record<string, unknown>;

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asObject(v: unknown): ServerMap {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as ServerMap) : {};
}

function asNameList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export class FileMcpServerCatalog implements McpServerCatalog {
  private readonly claudeJsonPath: string;

  constructor(claudeJsonPath?: string) {
    this.claudeJsonPath = claudeJsonPath ?? join(homedir(), ".claude.json");
  }

  listInherited(cwd: string): ServerMap {
    const claudeJson = readJson(this.claudeJsonPath) ?? {};
    const user = asObject(claudeJson.mcpServers);

    const projects = asObject(claudeJson.projects);
    const projectEntry = asObject(projects[cwd] ?? this.entryByRealpath(projects, cwd));
    const local = asObject(projectEntry.mcpServers);
    const project = this.projectScopeServers(cwd, projectEntry);

    return { ...user, ...project, ...local };
  }

  private entryByRealpath(projects: ServerMap, cwd: string): unknown {
    try {
      return projects[realpathSync(cwd)];
    } catch {
      return undefined;
    }
  }

  // .mcp.json servers, gated like claude does: an empty enabled-list means
  // "allow all"; a non-empty one is an allowlist; disabled always wins.
  private projectScopeServers(cwd: string, projectEntry: ServerMap): ServerMap {
    const dotMcp = readJson(join(cwd, ".mcp.json"));
    const all = asObject(dotMcp?.mcpServers);
    const enabled = asNameList(projectEntry.enabledMcpjsonServers);
    const disabled = new Set(asNameList(projectEntry.disabledMcpjsonServers));
    const out: ServerMap = {};
    for (const [name, def] of Object.entries(all)) {
      if (disabled.has(name)) continue;
      if (enabled.length > 0 && !enabled.includes(name)) continue;
      out[name] = def;
    }
    return out;
  }
}
