import type { CommandHandler } from "../pipeline.ts";
import { spawnWorkerCommand } from "../../../contracts/src/commands/defs.ts";
import type { NoAddr } from "../../../contracts/src/commands/types.ts";
import type { SpawnWorkerRequest, SpawnWorkerResponse } from "../../../contracts/src/http.ts";
import { spawnWorker } from "../../../core/src/use-cases/SpawnWorker.ts";
import { resolveSpawnIsolation } from "../../../core/src/domain/worktree-policy.ts";
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
    // Mode inheritance: explicit body.permissionMode wins; otherwise resolve
    // from parent so children adopt the orchestrator's current mode. Git agents
    // run shell-heavy git ops; the prompt file carries the safety rules, so they
    // default to bypassPermissions + persistent for a conversational session.
    const isGitAgent = body.role === "git";
    const claudePermissionMode = body.permissionMode
      ?? (isGitAgent ? "bypassPermissions" : undefined)
      ?? (body.parentId ? c.modeResolver.resolveFor(body.parentId) : undefined);
    const iso = resolveSpawnIsolation(body, {
      worktreesDisabled: c.userSettings.read()["git.spawnWithoutWorktree"] === true,
    });
    const { promptTemplate: _promptTemplate, ...bodyRest } = body;
    // Backend selection (defaults to claude-cli): resolve BEFORE the spec so a
    // profile-driven backend's model + profile name thread into it. claude-cli
    // keeps today's behavior exactly (no model override, null profile).
    const rb = await resolveSpawnBackend(c, { explicitKind: body.backendKind, parentId: body.parentId ?? null, isOrchestrator: false });
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
      ...(isGitAgent ? {
        persistent: true,
        model: body.model ?? "sonnet",
        effort: body.effort ?? "medium",
      } : {}),
      // Profile-model providers (metered lanes: deepseek/kimi/openai) carry the
      // profile's model; request-model providers (claude-sdk/claude-cli) run the
      // Claude model the user picked. Persist the resolved profile name for inheritance.
      ...(backend.descriptor.modelSource === "profile" ? { model: rb.model } : {}),
      backendProfile: rb.profileName ?? undefined,
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
