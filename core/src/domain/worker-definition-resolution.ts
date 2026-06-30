// Pure, deterministic, Clock-free worker-definition resolution. THIS IS THE OCP CORE:
// adding a type never edits this file. Full-override by name across sources,
// with an explicit `extends:` chain as the ONLY cross-source field reuse.

import type { EffortLevel } from "../../../contracts/src/shared.ts";
import type { PermissionMode } from "../../../contracts/src/worker.ts";
import { DEFAULT_WORKER_DEFINITION } from "../../../contracts/src/worker-definition.ts";
import type { ToolScope, WorkerDefinition, WorkerDefinitionRecord } from "../../../contracts/src/worker-definition.ts";

// The per-axis defaults a resolved type pre-fills onto the spawn spec. The
// caller spreads only the fields the request left unset (applyWorkerDefinitionDefaults
// already drops request-set fields, so the spread can never override an explicit
// request value).
export interface WorkerDefinitionDefaults {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  backendKind?: string;
  backendProfile?: string;
  persistent?: boolean;
  collaborate?: boolean;
  isolation?: "worktree" | "cwd";
}

// The definition name a spawn resolves to. Explicit `from` wins (trimmed); the
// legacy role:"git" shim maps to the git built-in; everything else — including an
// omitted or whitespace-only `from` — falls back to the general-purpose default.
// A spawn ALWAYS names a definition: "no `from`" means general-purpose, never
// "no definition".
export function resolveDefinitionName(from: string | undefined, role: string | undefined): string {
  return from?.trim() || (role === "git" ? "git" : DEFAULT_WORKER_DEFINITION);
}

// Pick the winning definition by name. recordsByPriority is lowest→highest; the
// LAST match wins entirely (full-override). Then resolve `extends`. Returns null
// if no name matches — the spawn handler turns a null into a hard error (there is
// no base worker; resolveDefinitionName guarantees a name, so only a genuinely
// unknown or misconfigured definition yields null).
export function resolveWorkerDefinitionByName(
  name: string,
  recordsByPriority: WorkerDefinitionRecord[],
): WorkerDefinition | null {
  if (!name) return null;
  const winner = lastByName(name, recordsByPriority);
  if (!winner) return null;
  return resolveExtends(winner, recordsByPriority, new Set());
}

function lastByName(name: string, records: WorkerDefinitionRecord[]): WorkerDefinitionRecord | null {
  let found: WorkerDefinitionRecord | null = null;
  for (const r of records) if (r.name === name) found = r;
  return found;
}

// Overlay the child's set fields onto its resolved base (child wins per-field).
// Cycle guard via a `seen` set, mirroring SqlBackedBackendResolver.
function resolveExtends(
  record: WorkerDefinitionRecord,
  records: WorkerDefinitionRecord[],
  seen: Set<string>,
): WorkerDefinition {
  const { source: _source, ...child } = record;
  if (!record.extends || seen.has(record.name)) return child;
  seen.add(record.name);
  const baseRecord = lastByName(record.extends, records);
  if (!baseRecord) return child;
  const base = resolveExtends(baseRecord, records, seen);
  return overlay(base, child);
}

// Child set fields win; unset child fields fall back to base. `extends` itself is
// consumed at this level and never carried onto the result.
function overlay(base: WorkerDefinition, child: WorkerDefinition): WorkerDefinition {
  const out: WorkerDefinition = { ...base };
  for (const [k, v] of Object.entries(child)) {
    if (k === "extends") continue;
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  out.extends = undefined;
  return out;
}

// Fold the resolved type's set fields into the spawn spec where the request left
// them unset. Returns ONLY the fields the type pre-fills (the caller spreads).
export function applyWorkerDefinitionDefaults(
  t: WorkerDefinition,
  requestHas: (field: string) => boolean,
): WorkerDefinitionDefaults {
  const out: WorkerDefinitionDefaults = {};
  if (t.model !== undefined && !requestHas("model")) out.model = t.model;
  if (t.effort !== undefined && !requestHas("effort")) out.effort = t.effort;
  if (t.permissionMode !== undefined && !requestHas("permissionMode")) out.permissionMode = t.permissionMode;
  if (t.backendKind !== undefined && !requestHas("backendKind")) out.backendKind = t.backendKind;
  if (t.backendProfile !== undefined && !requestHas("backendProfile")) out.backendProfile = t.backendProfile;
  if (t.persistent !== undefined && !requestHas("persistent")) out.persistent = t.persistent;
  if (t.collaborate !== undefined && !requestHas("collaborate")) out.collaborate = t.collaborate;
  if (t.isolation !== undefined && !requestHas("isolation")) out.isolation = t.isolation;
  return out;
}

// Combined `provider/model` form: when a definition's model is written as
// `<provider>/<model>` AND `<provider>` is a configured backend (a key in
// config.backends, threaded as the set here — keeps this pure + Node-free), it is
// sugar for backendProfile=<provider> + model=<everything after the first `/>`. A
// bare model id, an unconfigured prefix, or an empty prefix/suffix stays plain so
// legacy values (and provider-routed slash ids like "anthropic/claude-…" on a
// differently-named profile) are untouched.
export function splitProviderModel(
  model: string,
  configuredBackends: ReadonlySet<string>,
): { backendProfile?: string; model: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return { model };
  const prefix = model.slice(0, slash);
  if (!configuredBackends.has(prefix)) return { model };
  return { backendProfile: prefix, model: model.slice(slash + 1) };
}

// Materialize the tool surface (string globs) into a ToolScope value. Baked once
// at spawn so the gate hot path never re-resolves the type.
export function materializeToolScope(t: WorkerDefinition): ToolScope {
  return { allow: t.toolsAllow ?? [], deny: t.toolsDeny ?? [], editRegex: t.editRegex ?? null };
}

// True when a materialized scope actually restricts anything (worth persisting +
// consulting). An all-empty scope is equivalent to no scope.
export function isToolScopeRestrictive(s: ToolScope): boolean {
  return s.allow.length > 0 || s.deny.length > 0 || s.editRegex !== null;
}
