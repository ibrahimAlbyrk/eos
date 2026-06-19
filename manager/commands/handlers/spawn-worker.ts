import type { CommandHandler } from "../pipeline.ts";
import { spawnWorkerCommand } from "../../../contracts/src/commands/defs.ts";
import type { NoAddr } from "../../../contracts/src/commands/types.ts";
import type { SpawnWorkerRequest, SpawnWorkerResponse } from "../../../contracts/src/http.ts";
import { spawnWorker } from "../../../core/src/use-cases/SpawnWorker.ts";
import { resolveSpawnIsolation } from "../../../core/src/domain/worktree-policy.ts";
import { resolveWorkerTypeByName, applyWorkerTypeDefaults, materializeToolScope, isToolScopeRestrictive } from "../../../core/src/domain/worker-type-resolution.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";
import { errMsg } from "../../../contracts/src/util.ts";
import { expandPath } from "../../shared/path.ts";
import { appendSynthesized } from "../../shared/synthesized-events.ts";
import { resolveSpawnBackend, spawnBackendError } from "../../shared/spawn-backend.ts";

export const spawnWorkerHandler: CommandHandler<NoAddr, SpawnWorkerRequest, SpawnWorkerResponse> = {
  def: spawnWorkerCommand,
  async run(_addr, body, { c }) {
    // Resolve a prompt-template reference (promptTemplate) into the boot prompt
    // through the prompt system — directives live in manager/prompts/, never
    // hardcoded in clients. A literal `prompt` (when given) wins.
    let bootPrompt = body.prompt;
    if (!bootPrompt && body.promptTemplate) {
      try {
        bootPrompt = c.prompts.render(body.promptTemplate.id, body.promptTemplate.vars ?? {}).trim();
      } catch (e) {
        throw new ValidationError(`promptTemplate render failed: ${errMsg(e)}`);
      }
    }
    if (!bootPrompt) throw new ValidationError("resolved prompt is empty");
    // Resolve the worker type → per-axis defaults + instructions body. `git` is
    // now just a built-in type (manager/worker-types/git.md); legacy role:"git"
    // requests map to workerType:"git" until callers migrate. Unknown/unset name
    // → null → a plain base worker (graceful degrade, never throws). The project
    // .eos/workers dir is found from the RAW request cwd — the isolation downgrade
    // below doesn't change WHERE the repo's types live.
    const workerTypeName = body.workerType ?? (body.role === "git" ? "git" : "");
    const lookupCwd = expandPath(body.worktreeFrom ?? body.cwd) ?? null;
    // Disk records (builtin < user < project) + the owning orchestrator's runtime
    // mints (highest precedence). Per-owner: a sibling orchestrator's mints never
    // leak here (the scope guard).
    const records = [
      ...c.listWorkerTypeRecords(lookupCwd),
      ...(body.parentId ? c.runtimeWorkerTypes.listFor(body.parentId) : []),
    ];
    const type = workerTypeName ? resolveWorkerTypeByName(workerTypeName, records) : null;
    const requestHas = (f: string) => (body as Record<string, unknown>)[f] !== undefined;
    const td = type ? applyWorkerTypeDefaults(type, requestHas) : {};
    // Materialize the tool surface once at spawn (baked onto the row; the gate
    // reads it per call). An all-empty scope persists as null — equivalent to
    // no restriction, and keeps unrestricted types (git) off the gate rung.
    const scope = type ? materializeToolScope(type) : null;
    const toolScope = scope && isToolScopeRestrictive(scope) ? scope : null;
    // Isolation: the user's global worktree-disable wins; otherwise the type's
    // declared isolation default takes effect (the request carries no explicit
    // isolation field, so a type's preference applies whenever it set one).
    const iso = resolveSpawnIsolation(body, {
      worktreesDisabled: c.userSettings.read()["git.spawnWithoutWorktree"] === true,
      typeIsolation: td.isolation,
    });
    // Mode inheritance: explicit body.permissionMode wins; else the type's
    // default (git → bypassPermissions); else resolve from parent so children
    // adopt the orchestrator's current mode.
    const claudePermissionMode = body.permissionMode
      ?? td.permissionMode
      ?? (body.parentId ? c.modeResolver.resolveFor(body.parentId) : undefined);
    const { promptTemplate: _promptTemplate, ...bodyRest } = body;
    // Backend selection (defaults to claude-cli): resolve BEFORE the spec so a
    // profile-driven backend's model + profile name thread into it. A type may
    // default backendKind where the request left it unset. claude-cli keeps
    // today's behavior exactly (no model override, null profile).
    const rb = await resolveSpawnBackend(c, { explicitKind: body.backendKind ?? td.backendKind, parentId: body.parentId ?? null, isOrchestrator: false });
    const backend = c.backends.has(rb.kind) ? c.backends.get(rb.kind) : c.claudeCliBackend;
    // Billing/enablement guard on the RESOLVED backend (covers profile/inherit/
    // default picks, not just explicit body.backendKind): rejects a metered API
    // without a costMode:"billed" opt-in, or an explicit pick of a disabled backend.
    const backendErr = spawnBackendError(backend, rb, !!body.backendKind);
    if (backendErr) throw new ValidationError(backendErr);
    const spec = {
      ...bodyRest,
      prompt: bootPrompt,
      cwd: expandPath(iso.cwd),
      worktreeFrom: expandPath(iso.worktreeFrom),
      carryUncommitted: c.userSettings.read()["git.carryUncommitted"] === true,
      hydrateEnv: c.config.worker.hydrateEnvFiles,
      claudePermissionMode,
      // Type defaults — only the axes the request left unset (applyWorkerType-
      // Defaults already dropped request-set fields, so these never override an
      // explicit request value).
      ...(td.model !== undefined ? { model: td.model } : {}),
      ...(td.effort !== undefined ? { effort: td.effort } : {}),
      ...(td.persistent !== undefined ? { persistent: td.persistent } : {}),
      ...(td.collaborate !== undefined ? { collaborate: td.collaborate } : {}),
      // Profile-model providers (metered lanes: deepseek/kimi/openai) carry the
      // profile's model; request-model providers (claude-sdk/claude-cli) run the
      // Claude model the user picked. Persist the resolved profile name for inheritance.
      ...(backend.descriptor.modelSource === "profile" ? { model: rb.model } : {}),
      backendProfile: rb.profileName ?? undefined,
      // Carry the resolved type onto the spec: persisted (worker_type column) and
      // surfaced as the DPI workerType fact + the role/20 instructions fragment.
      workerType: type?.name ?? "",
      workerTypeBody: type?.body ?? "",
      // Materialized tool scope (persisted to tool_scope; enforced by the gate).
      toolScope: toolScope ?? undefined,
    };
    const result = await spawnWorker(
      {
        workers: c.workers,
        events: c.events,
        bus: c.bus,
        supervisor: c.supervisor,
        ports: c.portAllocator,
        clock: c.clock,
        ids: c.ids,
        log: c.log,
        buildArgs: c.buildArgs,
        buildEnv: c.buildEnv,
        resolveWorktreeDir: c.resolveWorktreeDir,
        logFileFor: c.logFileFor,
        backend,
        worktrees: c.worktrees,
        onAgentEvent: c.onAgentEvent,
        recents: c.recents,
        caps: c.modelCatalog,
      },
      spec,
    );
    // The boot prompt renders exactly once. A PARENTED worker shows it as the
    // "Task from <orchestrator>" card (web MessageTask, sourced from the
    // worker.prompt column) — a synthesized chat event here would render it a
    // SECOND time (left task card + right user bubble). A top-level worker (no
    // parent, hence no task card) has no other surface, so it gets the boot
    // prompt as a user_message. The gate is "will a task card render?" = "has a
    // parent?", NOT the backend's reportsMessageEvents (which is about runtime
    // dispatch echo, not the boot prompt).
    if (!body.parentId) {
      appendSynthesized(c, result.id, "user_message", { text: bootPrompt });
    }
    const isolation = spec.worktreeFrom || body.workspaceOf ? "worktree" : "cwd";
    return { status: 201, body: { ...result, isolation } };
  },
};
