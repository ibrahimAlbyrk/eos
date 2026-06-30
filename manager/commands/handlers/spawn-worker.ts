import type { CommandHandler } from "../pipeline.ts";
import { spawnWorkerCommand } from "../../../contracts/src/commands/defs.ts";
import type { NoAddr } from "../../../contracts/src/commands/types.ts";
import type { SpawnWorkerRequest, SpawnWorkerResponse } from "../../../contracts/src/http.ts";
import { DEFAULT_WORKER_DEFINITION } from "../../../contracts/src/worker-definition.ts";
import type { WorkerDefinition } from "../../../contracts/src/worker-definition.ts";
import { spawnWorker } from "../../../core/src/use-cases/SpawnWorker.ts";
import { armLoopAtSpawn } from "../../services/arm-loop-at-spawn.ts";
import { resolveSpawnIsolation } from "../../../core/src/domain/worktree-policy.ts";
import { resolveDefinitionName, resolveWorkerDefinitionByName, applyWorkerDefinitionDefaults, materializeToolScope, isToolScopeRestrictive, resolveCombinedModel } from "../../../core/src/domain/worker-definition-resolution.ts";
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
    // Arm-at-spawn preconditions — fail fast BEFORE creating the worker so a
    // disabled/unparented loop request never orphans a spawned worker.
    if (body.loop) {
      if (!c.config.loop.enabled) throw new ValidationError("dynamic loop is disabled — set config.loop.enabled");
      if (!body.parentId) throw new ValidationError("a dynamic loop can only be armed on a worker spawned by an orchestrator");
    }
    // Resolve the available worker (`from`) → per-axis defaults + instructions
    // body. `git` is a built-in definition (manager/workers/git.md); legacy
    // role:"git" requests map to from:"git" until callers migrate. An omitted or
    // empty `from` resolves to the general-purpose built-in — there is NO
    // definition-less worker. An explicit but unknown name is a hard error: a
    // typo'd specialist must never silently degrade to general-purpose. The
    // project .eos/workers dir is found from the RAW request cwd — the isolation
    // downgrade below doesn't change WHERE the repo's definitions live.
    const definitionName = resolveDefinitionName(body.from, body.role);
    const lookupCwd = expandPath(body.worktreeFrom ?? body.cwd) ?? null;
    // Disk records (builtin < user < project) + the owning orchestrator's runtime
    // definitions (highest precedence). Per-owner: a sibling orchestrator's
    // definitions never leak here (the scope guard).
    const defOwner = body.definitionOwnerId ?? body.parentId;
    const records = [
      ...c.listWorkerDefinitionRecords(lookupCwd),
      ...(defOwner ? c.runtimeWorkerDefinitions.listFor(defOwner) : []),
    ];
    let def = resolveWorkerDefinitionByName(definitionName, records);
    if (!def) {
      throw new ValidationError(
        definitionName === DEFAULT_WORKER_DEFINITION
          ? `default worker definition "${DEFAULT_WORKER_DEFINITION}" not found — check the worker-definitions dir`
          : `unknown worker definition: ${definitionName}`,
      );
    }
    // Combined `provider/model` model form (e.g. model: "deepseek/deepseek-v4-pro"):
    // sugar for backendProfile=<provider> + model=<rest> when <provider> is a
    // configured backend. resolveCombinedModel also NORMALIZES a redundant prefix
    // already on its own profile (backendProfile:deepseek + model:"deepseek/…" →
    // bare model) so a configured-backend prefix never reaches a client raw, while
    // an explicit DIFFERENT profile and provider-routed slash ids stay intact.
    if (def.model?.includes("/")) {
      const combined = resolveCombinedModel(def.model, def.backendProfile, new Set(Object.keys(c.config.backends)));
      def = { ...def, model: combined.model, backendProfile: combined.backendProfile };
    }
    const requestHas = (f: string) => (body as Record<string, unknown>)[f] !== undefined;
    const dd = applyWorkerDefinitionDefaults(def, requestHas);
    // Materialize the tool surface once at spawn (baked onto the row; the gate
    // reads it per call). An all-empty scope persists as null — equivalent to
    // no restriction, and keeps unrestricted definitions (git) off the gate rung.
    // Inline request scope (toolsAllow/toolsDeny/editRegex) fences a one-off
    // worker WITHOUT a reusable definition and OVERRIDES a `from` definition's
    // scope entirely (explicit request wins).
    const inlineScopeSrc = (body.toolsAllow || body.toolsDeny || body.editRegex)
      ? { toolsAllow: body.toolsAllow, toolsDeny: body.toolsDeny, editRegex: body.editRegex }
      : null;
    const scope = inlineScopeSrc
      ? materializeToolScope(inlineScopeSrc as WorkerDefinition)
      : materializeToolScope(def);
    const toolScope = scope && isToolScopeRestrictive(scope) ? scope : null;
    // Isolation: the user's global worktree-disable wins; otherwise the
    // definition's declared isolation default takes effect (the request carries
    // no explicit isolation field, so a definition's preference applies whenever set).
    const iso = resolveSpawnIsolation(body, {
      worktreesDisabled: c.userSettings.read()["git.spawnWithoutWorktree"] === true,
      definitionIsolation: dd.isolation,
    });
    // Mode inheritance: explicit body.permissionMode wins; else the definition's
    // default (git → bypassPermissions); else resolve from parent so children
    // adopt the orchestrator's current mode.
    const claudePermissionMode = body.permissionMode
      ?? dd.permissionMode
      ?? (body.parentId ? c.modeResolver.resolveFor(body.parentId) : undefined);
    const { promptTemplate: _promptTemplate, from: _from, toolsAllow: _toolsAllow, toolsDeny: _toolsDeny, editRegex: _editRegex, loop: _loop, ...bodyRest } = body;
    // Backend selection (defaults to claude-cli): resolve BEFORE the spec so a
    // profile-driven backend's model + profile name thread into it. A definition
    // may default backendKind where the request left it unset. claude-cli keeps
    // today's behavior exactly (no model override, null profile).
    //
    // The profile-override model may override a profile's pinned model ONLY when it
    // was chosen FOR that profile: the DEFINITION's own model (def.model, post combined-
    // split) for a def-driven profile, or body.model only when the REQUEST itself picked
    // the profile (backendProfile in the request). A bare inherited body.model — a parent
    // orchestrator's Claude default like "sonnet" forwarded by spawn_worker — must NEVER
    // override a def's profile-bound model, or it cross-poisons the metered lane and 400s
    // the provider. (def.model, not dd.model: dd.model is nulled once the request carries
    // any model, so it can't carry the def's profile-bound model here.) Non-profile/Claude
    // lanes ignore explicitModel entirely and flow the model through the spec below.
    const profileOverrideModel = requestHas("backendProfile") ? body.model : def.model;
    const rb = await resolveSpawnBackend(c, { explicitKind: body.backendKind ?? dd.backendKind, explicitProfileName: dd.backendProfile, explicitModel: profileOverrideModel, parentId: body.parentId ?? null, isOrchestrator: false });
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
      // Definition defaults — only the axes the request left unset (applyWorker-
      // DefinitionDefaults already dropped request-set fields, so these never
      // override an explicit request value).
      ...(dd.model !== undefined ? { model: dd.model } : {}),
      ...(dd.effort !== undefined ? { effort: dd.effort } : {}),
      ...(dd.persistent !== undefined ? { persistent: dd.persistent } : {}),
      ...(dd.collaborate !== undefined ? { collaborate: dd.collaborate } : {}),
      // Profile-model providers (metered lanes: deepseek/kimi/openai) carry the
      // profile's model; request-model providers (claude-sdk/claude-cli) run the
      // Claude model the user picked. Persist the resolved profile name for inheritance.
      ...(backend.descriptor.modelSource === "profile" ? { model: rb.model } : {}),
      backendProfile: rb.profileName ?? undefined,
      // Resolved launch references threaded to the in-process env factory (creds
      // by reference, origin baseUrl, provider params/capabilities). Harmless on
      // the claude lanes (they read backendOptions.spec, not these).
      backendAuth: rb.auth,
      backendBaseUrl: rb.baseUrl,
      backendParams: rb.params,
      backendCapabilities: rb.capabilities,
      // Carry the resolved definition onto the spec: persisted (worker_definition
      // column) and surfaced as the DPI workerDefinition fact + the role/20 fragment.
      // def is always resolved now (defaults to general-purpose; unknown ⇒ thrown above).
      workerDefinition: def.name,
      workerDefinitionBody: def.body,
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
    // Arm-at-spawn: attach the loop to the just-created worker BEFORE its first
    // turn. SPAWNING (not IDLE) so no immediate tick — the first idle edge ticks
    // it. The loop now precedes every IDLE edge (no dormancy race) + holds the
    // first report (R7).
    if (body.loop && body.parentId) {
      armLoopAtSpawn(
        { loops: c.loops, workers: c.workers, ids: c.ids, clock: c.clock, bus: c.bus, loopConfig: c.config.loop },
        { parentId: body.parentId, workerId: result.id, loop: body.loop },
      );
    }
    const isolation = spec.worktreeFrom || body.workspaceOf ? "worktree" : "cwd";
    return { status: 201, body: { ...result, isolation } };
  },
};
