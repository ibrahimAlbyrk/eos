import { existsSync } from "node:fs";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import {
  SpawnWorkerRequestSchema,
  EventsQuerySchema,
  MessageRequestSchema,
  ReportRequestSchema,
  SetNameRequestSchema,
  SetPermissionRequestSchema,
  SetModelRequestSchema,
  QuestionRequestSchema,
  QuestionAnswerRequestSchema,
  QuestionNotifyRequestSchema,
  NotifyRequestSchema,
  WorkerActionRequestSchema,
  RewindRequestSchema,
  FileDiffQuerySchema,
  TerminalRunRequestSchema,
  WorkspaceTerminalRunRequestSchema,
} from "../../contracts/src/http.ts";
import type { WorkerRow } from "../../contracts/src/worker.ts";

import { spawnWorker } from "../../core/src/use-cases/SpawnWorker.ts";
import { killWorker } from "../../core/src/use-cases/KillWorker.ts";
import { dispatchMessage } from "../../core/src/use-cases/DispatchMessage.ts";
import { transitionState } from "../../core/src/use-cases/TransitionState.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { processWorkerEvent } from "../../core/src/use-cases/ProcessWorkerEvent.ts";
import { toCanonicalEvents } from "../../spawner/canonical-map.ts";
import { setWorkerPermissionMode } from "../../core/src/use-cases/SetWorkerPermissionMode.ts";
import { setWorkerModel } from "../../core/src/use-cases/SetWorkerModel.ts";
import { expandPath } from "../shared/path.ts";
import { resumeWorkerVia, resumeIfDead } from "./resume-helpers.ts";
import { dispatchDeps } from "./dispatch-deps.ts";
import { resolveWorkerAction } from "../services/worker-actions.ts";
import { pushBranch } from "../../core/src/use-cases/PushBranch.ts";
import { decidePushPlan, isActionablePushPlan } from "../../core/src/domain/push-plan.ts";
import { resolveSpawnIsolation } from "../../core/src/domain/worktree-policy.ts";

// Where the agent actually edits: the worktree dir when spawned with a
// worktree (cwd is NULL for those rows), plain cwd otherwise. worktree_from
// only as fallback for the window before worktree_dir enrichment lands.
function gitDirOf(w: WorkerRow | null): string | null {
  return w ? (w.worktree_dir ?? w.cwd ?? w.worktree_from ?? null) : null;
}

// Diff base for worktree workers: the fork point, so commits the agent made
// after forking still show in /diff and /changes (an agent that commits must
// never look "clean"). Prefer the SHA stamped at worktree creation — the
// merge-base fallback (pre-027 rows) re-derives against the source checkout's
// CURRENT head, which drifts when the user rewinds past the fork point and
// makes a clean worktree look dirty. Null → plain HEAD diff.
async function diffBaseOf(c: Container, w: WorkerRow | null): Promise<string | undefined> {
  if (!w?.worktree_dir || !w.worktree_from) return undefined;
  if (w.fork_base_sha) return w.fork_base_sha;
  return (await c.git.mergeBase(w.worktree_dir, w.worktree_from)) ?? undefined;
}


export function registerWorkerRoutes(r: Router, c: Container): void {
  r.get("/workers", ({ res }) => {
    writeJson(res, 200, c.workers.listAll());
  });

  r.post("/workers", async ({ req, res }) => {
    const raw = await readBody(req);
    const body = validate(SpawnWorkerRequestSchema, raw);
    // Normalize tilde paths upstream so use-cases see absolute paths only.
    // Mode inheritance: explicit body.permissionMode wins; otherwise resolve
    // from parent so children adopt the orchestrator's current mode.
    // Git agents run shell-heavy git ops; the prompt file carries the safety
    // rules (destructive ops require AskUserQuestion), so they default to
    // bypassPermissions + persistent for a conversational session.
    const isGitAgent = body.role === "git";
    const claudePermissionMode = body.permissionMode
      ?? (isGitAgent ? "bypassPermissions" : undefined)
      ?? (body.parentId ? c.modeResolver.resolveFor(body.parentId) : undefined);
    const systemPromptFile = isGitAgent
      ? c.config.paths.gitAgentPromptFile
      : body.parentId
        ? c.config.paths.workerPromptFile
        : undefined;
    const iso = resolveSpawnIsolation(body, {
      worktreesDisabled: c.userSettings.read()["git.spawnWithoutWorktree"] === true,
    });
    const spec = {
      ...body,
      cwd: expandPath(iso.cwd),
      worktreeFrom: expandPath(iso.worktreeFrom),
      claudePermissionMode,
      systemPromptFile,
      ...(isGitAgent ? {
        persistent: true,
        model: body.model ?? "sonnet",
        effort: body.effort ?? "medium",
      } : {}),
    };
    // Backend selection: resolve the effective backend (defaults to claude-cli)
    // and pick the adapter. claude-cli keeps today's behavior exactly.
    const rb = c.backendResolver.resolveForNewWorker({ parentId: body.parentId ?? null, isOrchestrator: false });
    const backend = c.backends.has(rb.kind) ? c.backends.get(rb.kind) : c.claudeCliBackend;
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
        onAgentEvent: c.onAgentEvent,
        recents: c.recents,
        caps: c.modelCatalog,
      },
      spec,
    );
    if (isGitAgent && body.prompt) {
      c.events.append(result.id, c.clock.now(), "user_message", { text: body.prompt });
      c.bus.publish("worker:change", { workerId: result.id });
    }
    const isolation = spec.worktreeFrom || body.workspaceOf ? "worktree" : "cwd";
    writeJson(res, 201, { ...result, isolation });
  });

  r.get(/^\/workers\/(?<id>[^/]+)$/, ({ params, res }) => {
    const row = c.workers.findById(params.id);
    if (!row) { writeJson(res, 404, { error: "not found" }); return; }
    writeJson(res, 200, row);
  });

  r.del(/^\/workers\/(?<id>[^/]+)$/, ({ params, res }) => {
    const supervisorWithFind = c.supervisor as ReturnType<typeof import("../../infra/src/supervision/ChildProcessSupervisor.ts").createChildProcessSupervisor>;
    const result = killWorker(
      {
        workers: c.workers,
        events: c.events,
        pending: c.pending,
        messageQueue: c.messageQueue,
        bus: c.bus,
        supervisor: c.supervisor,
        log: c.log,
        findOrphanPids: (safeName) => supervisorWithFind.findPidsByPattern(`eos-${safeName}-`),
        postKillCleanup: (id) => {
          c.cleanupMcpConfig(id);
        },
        cleanupWorktree: (ref) => {
          // Shared-workspace guard: an attached agent (workspaceOf) — or the
          // owner, when the attached agent is the one being deleted — may
          // still live in this worktree. Remove only when no remaining row
          // references the branch. (This fires 2s post-kill, so the deleted
          // worker's own row is already gone from listAll.)
          const shared = c.workers.listAll().some(
            (w) => w.branch === ref.branch && w.worktree_from === ref.repoRoot,
          );
          if (shared) {
            c.log.info("worktree kept — shared with another worker", { worker: params.id, branch: ref.branch });
          } else {
            void c.worktrees.remove(ref).catch((e) => c.log.warn("worktree cleanup failed", { worker: params.id, error: errMsg(e) }));
          }
          // Drop the try snapshot ref too. An active try's patch/state live
          // outside the worktree and are deliberately preserved — discard
          // must survive worker deletion.
          void c.branchIntegration.cleanupSnapshot({ repoRoot: ref.repoRoot, workerId: params.id })
            .catch((e) => c.log.warn("snapshot cleanup failed", { worker: params.id, error: errMsg(e) }));
        },
      },
      params.id,
    );
    c.pendingQuestions.rejectByWorker(params.id, new Error("worker killed"));
    writeJson(res, 200, { killed: result.killed, removed: result.removed, was_state: result.wasState });
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/events$/, ({ params, url, res }) => {
    const q = validate(EventsQuerySchema, {
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      order: url.searchParams.get("order") ?? undefined,
      beforeId: url.searchParams.get("beforeId") ?? undefined,
    });
    const rows = c.events.list({ workerId: params.id, since: q.since, limit: q.limit, order: q.order, beforeId: q.beforeId });
    writeJson(res, 200, rows);
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/events$/, async ({ params, req, res }) => {
    const body = await readBody(req) as { type?: string; payload?: unknown };
    if (!body.type) { writeJson(res, 400, { error: "type required" }); return; }
    processWorkerEvent(
      {
        workers: c.workers, events: c.events, bus: c.bus,
        clock: c.clock, models: c.models, log: c.log,
        isSettling: (id) => c.turnSettle.isSettling(id),
        markSettling: (id) => c.turnSettle.mark(id),
        toCanonical: toCanonicalEvents,
      },
      { workerId: params.id, type: body.type, payload: body.payload },
    );
    // /clear marker: mirror of conversation_rewound — the web hides everything
    // before it. Synthesized here because the signal arrives as a plain hook.
    const hp = body.payload as { event?: string; body?: { reason?: string; session_id?: string } } | undefined;
    if (body.type === "hook" && hp?.event === "SessionEnd" && hp?.body?.reason === "clear") {
      const rowId = c.events.append(params.id, c.clock.now(), "conversation_cleared", {
        prevSessionId: hp.body?.session_id ?? null,
      });
      c.bus.publish("worker:change", { workerId: params.id, rowId });
    }
    writeJson(res, 200, { ok: true });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const raw = await readBody(req) as { text?: string; fromParent?: string };
    const body = validate(MessageRequestSchema, raw);
    const fromParent = typeof raw.fromParent === "string" ? raw.fromParent : null;

    const target = c.workers.findById(params.id);
    if (!target) { writeJson(res, 404, { error: "worker not found" }); return; }
    await resumeIfDead(c, target);

    if (fromParent) {
      c.turnSettle.clear(params.id);
      const worker = c.workers.findById(params.id);
      if (!worker?.port) { writeJson(res, 404, { error: "worker not found" }); return; }
      const parent = c.workers.findById(fromParent);
      const parentName = parent?.name ?? fromParent;
      try {
        // The worker records the orchestrator_message event itself when the
        // directive lands in its transcript — see DispatchMessage header for
        // why a dispatch-time append misorders against trailing turn output.
        await c.httpWorkerClient.sendMessage(worker.port, body.text, {
          as: "orchestrator_message", fromParent, parentName,
        });
      } catch (e) {
        writeJson(res, 502, { error: "worker unreachable" }); return;
      }
      transitionState(
        { workers: c.workers, events: c.events, bus: c.bus, clock: c.clock },
        { workerId: params.id, next: "WORKING", reason: "orchestrator_message" },
      );
      c.bus.publish("worker:change", { workerId: params.id });
      writeJson(res, 200, { ok: true });
      return;
    }

    c.turnSettle.clear(params.id);
    const result = await dispatchMessage(
      dispatchDeps(c),
      {
        workerId: params.id, text: body.text,
        clientMsgId: body.clientMsgId, queueWhenBusy: body.queueWhenBusy,
        origin: "dashboard",
      },
    );
    writeJson(res, result.status, result.body);
  });

  // Daemon-side message queue — pills render from this; dismiss deletes a
  // still-pending row (a drained row is gone from the pending list already).
  r.get(/^\/workers\/(?<id>[^/]+)\/queue$/, ({ params, res }) => {
    const rows = c.messageQueue.listPending(params.id);
    writeJson(res, 200, { messages: rows.map((m) => ({ id: m.id, text: m.text, ts: m.createdAt })) });
  });

  r.del(/^\/workers\/(?<id>[^/]+)\/queue\/(?<queueId>\d+)$/, ({ params, res }) => {
    const removed = c.messageQueue.removePending(params.id, Number(params.queueId));
    if (removed) c.bus.publish("worker:change", { workerId: params.id });
    writeJson(res, removed ? 200 : 404, { ok: removed });
  });

  // Revive a dead-but-resumable worker under the same id — claude restores the
  // conversation via --resume <session_id>; the spec is rebuilt from the row.
  r.post(/^\/workers\/(?<id>[^/]+)\/resume$/, async ({ params, res }) => {
    const row = c.workers.findById(params.id);
    if (!row) { writeJson(res, 404, { error: "not found" }); return; }
    const result = await resumeWorkerVia(c, row);
    c.turnSettle.clear(params.id);
    writeJson(res, 200, result);
  });

  // Predefined action → resolve the prompt template server-side; the chat
  // shows only the short display label (the full prompt never reaches the UI).
  r.post(/^\/workers\/(?<id>[^/]+)\/action$/, async ({ params, req, res }) => {
    const body = validate(WorkerActionRequestSchema, await readBody(req));
    const { prompt, display } = resolveWorkerAction(c.promptTemplates, body.action);
    const target = c.workers.findById(params.id);
    if (!target) { writeJson(res, 404, { error: "worker not found" }); return; }
    await resumeIfDead(c, target);
    c.turnSettle.clear(params.id);
    const result = await dispatchMessage(
      dispatchDeps(c),
      { workerId: params.id, text: prompt, displayText: display, origin: "action" },
    );
    writeJson(res, result.status, result.body);
  });

  // Deterministic push — no agent turn. The daemon inspects the branch's sync
  // state and runs the correct git push variant itself (set-upstream / fast-forward
  // / force-with-lease), then records a git_push event so the chat keeps a record.
  r.post(/^\/workers\/(?<id>[^/]+)\/push$/, async ({ params, res }) => {
    const w = c.workers.findById(params.id);
    if (!w) { writeJson(res, 404, { error: "worker not found" }); return; }
    const dir = gitDirOf(w);
    if (!dir) { writeJson(res, 400, { error: "worker has no working directory" }); return; }
    const result = await pushBranch({ git: c.git, branchPush: c.branchPush }, dir);
    c.events.append(params.id, c.clock.now(), "git_push", result);
    c.bus.publish("worker:change", { workerId: params.id });
    writeJson(res, 200, result);
  });

  // Fire-and-forget notification that an AskUserQuestion is pending — surfaces the
  // web banner. The PermissionRequest hook has no tool_use_id, so synthesize one;
  // the banner keys off it and the web UI echoes it back to dismiss.
  r.post(/^\/workers\/(?<id>[^/]+)\/question-notify$/, async ({ params, req, res }) => {
    const body = validate(QuestionNotifyRequestSchema, await readBody(req));
    const toolUseId = body.toolUseId || c.ids.newPendingId();
    c.events.append(params.id, c.clock.now(), "question_pending", {
      toolUseId,
      questions: body.questions,
    });
    c.bus.publish("worker:change", { workerId: params.id });
    writeJson(res, 200, { ok: true });
  });

  // Worker's hook blocks here until user answers in web UI. The PermissionRequest
  // hook input has no tool_use_id, so synthesize one when absent — the banner and
  // the answer round-trip key off it, and a unique id keeps concurrent subagent
  // questions from superseding each other.
  r.post(/^\/workers\/(?<id>[^/]+)\/question$/, async ({ params, req, res }) => {
    const body = validate(QuestionRequestSchema, await readBody(req));
    const toolUseId = body.toolUseId || c.ids.newPendingId();

    c.events.append(params.id, c.clock.now(), "question_pending", {
      toolUseId,
      questions: body.questions,
    });
    c.bus.publish("worker:change", { workerId: params.id });

    const { promise } = c.pendingQuestions.register(params.id, toolUseId);
    const answers = await promise;
    writeJson(res, 200, { answers });
  });

  // Web UI posts answers here. When structured `selections` are present, the
  // worker drives Claude's native menu with verified keystrokes (answer-driver) —
  // this replaces the old web-side interrupt+message path whose Esc cancelled the
  // menu and made the agent receive a "rejected" result. The call always records
  // question_answered so the banner dismisses durably.
  r.post(/^\/workers\/(?<id>[^/]+)\/question-answer$/, async ({ params, req, res }) => {
    const body = validate(QuestionAnswerRequestSchema, await readBody(req));
    let outcome = "dismissed";
    const worker = c.workers.findById(params.id);
    if (worker?.port && c.supervisor.has(params.id)) {
      // Always resolve the worker's menu hold: with selections the worker drives
      // the native menu, without them it cancels the menu. Either way the worker
      // stops holding messages — leaving the menu unresolved wedges delivery.
      // Resolving resumes the turn, so clear the settle window too.
      c.turnSettle.clear(params.id);
      const driven = await c.httpWorkerClient.answerQuestion(worker.port, body.selections ?? []);
      outcome = driven.outcome ?? (driven.ok ? "answered" : "failed");
    }
    c.events.append(params.id, c.clock.now(), "question_answered", {
      toolUseId: body.toolUseId,
      answers: body.answers,
    });
    c.bus.publish("worker:change", { workerId: params.id });
    writeJson(res, 200, { ok: true, outcome });
  });

  // Orchestrator-initiated user notification. Fire-and-forget: published on
  // the bus as `notification:fire`; the native app delivers it only while
  // backgrounded (app/main.swift checks NSApp.isActive).
  r.post(/^\/workers\/(?<id>[^/]+)\/notify$/, async ({ params, req, res }) => {
    const body = validate(NotifyRequestSchema, await readBody(req));
    c.bus.publish("notification:fire", {
      title: body.title,
      body: body.body,
      workerId: params.id,
      ts: c.clock.now(),
    });
    writeJson(res, 200, { ok: true });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/keystroke$/, async ({ params, req, res }) => {
    const worker = c.workers.findById(params.id);
    if (!worker?.port) { writeJson(res, 404, { error: "worker not found" }); return; }
    if (!c.supervisor.has(params.id)) { writeJson(res, 409, { error: "worker not running" }); return; }
    const body = await readBody(req) as { keys?: string };
    if (!body.keys) { writeJson(res, 400, { error: "keys required" }); return; }
    try {
      await c.httpWorkerClient.sendKeystroke(worker.port, body.keys);
    } catch {
      writeJson(res, 502, { error: "worker unreachable" }); return;
    }
    writeJson(res, 200, { ok: true });
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/rewind-targets$/, async ({ params, res }) => {
    const worker = c.workers.findById(params.id);
    if (!worker?.port) { writeJson(res, 404, { error: "worker not found" }); return; }
    if (!c.supervisor.has(params.id)) { writeJson(res, 409, { error: "worker not running" }); return; }
    const data = await c.httpWorkerClient.getRewindTargets(worker.port);
    writeJson(res, 200, data);
  });

  // Drives the native TUI rewind via the worker's keystroke choreography. The
  // transcript is never truncated (Claude forks in memory), so on success we
  // append conversation_rewound — the web chat hides the abandoned branch at
  // that boundary and prefills the composer with the restored prompt.
  r.post(/^\/workers\/(?<id>[^/]+)\/rewind$/, async ({ params, req, res }) => {
    const body = validate(RewindRequestSchema, await readBody(req));
    const worker = c.workers.findById(params.id);
    if (!worker?.port) { writeJson(res, 404, { error: "worker not found" }); return; }
    if (!c.supervisor.has(params.id)) { writeJson(res, 409, { error: "worker not running" }); return; }
    const result = await c.httpWorkerClient.sendRewind(worker.port, { uuid: body.uuid, mode: body.mode });
    if (result.ok) {
      c.events.append(params.id, c.clock.now(), "conversation_rewound", {
        uuid: result.uuid,
        text: result.text,
        display: result.display,
        index: result.index,
        mode: body.mode,
      });
      c.bus.publish("worker:change", { workerId: params.id });
    }
    writeJson(res, 200, result);
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/interrupt$/, ({ params, res }) => {
    const worker = c.workers.findById(params.id);
    if (!worker?.port) { writeJson(res, 404, { error: "worker not found" }); return; }
    if (!c.supervisor.has(params.id)) { writeJson(res, 409, { error: "worker not running" }); return; }
    // Esc cancels what the user queued — clear BEFORE the IDLE transition or
    // the drain would fire the queued messages the interrupt meant to stop.
    const clearedQueued = c.messageQueue.clearPending(params.id);
    if (clearedQueued > 0) c.log.info("interrupt cleared queued messages", { workerId: params.id, count: clearedQueued });
    c.turnSettle.mark(params.id);
    c.httpWorkerClient.sendInterrupt(worker.port).catch(() => {});
    transitionState(
      { workers: c.workers, events: c.events, bus: c.bus, clock: c.clock },
      { workerId: params.id, next: "IDLE", reason: "interrupt" },
    );
    c.bus.publish("worker:change", { workerId: params.id });
    writeJson(res, 200, { ok: true });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/report$/, async ({ params, req, res }) => {
    const body = validate(ReportRequestSchema, await readBody(req));
    const worker = c.workers.findById(params.id);
    if (!worker) { writeJson(res, 404, { error: "worker not found" }); return; }
    if (!worker.parent_id) { writeJson(res, 400, { error: "worker has no parent" }); return; }

    c.bus.publish("worker:report", { workerId: params.id, parentId: worker.parent_id });

    const parent = c.workers.findById(worker.parent_id);
    if (!parent?.port || !c.supervisor.has(worker.parent_id)) {
      writeJson(res, 200, { ok: true, delivered: false });
      return;
    }

    const label = worker.name ?? params.id;
    // Compliance-independent merge handle: the header carries the branch and
    // worktree even when the worker forgot its Handover line. Branch-only
    // during the window before worktree_dir enrichment lands.
    const where = worker.branch
      ? worker.worktree_dir
        ? ` (branch ${worker.branch}, worktree ${worker.worktree_dir})`
        : ` (branch ${worker.branch})`
      : "";
    const formatted = `[worker ${label} (${params.id})] reported${where}:\n${body.text}`;

    // Opt-in auto-apply (settings: git.autoApplyOnReport): a finished worker's
    // changes land in the user's checkout as unstaged edits, same as clicking
    // Apply. Deterministic daemon-side git — no agent involved. Failures
    // (conflicts, dirty files, another active try) are logged and left for
    // the manual flow; nothing is half-applied.
    if (
      c.userSettings.read()["git.autoApplyOnReport"] === true &&
      worker.worktree_from && worker.branch && worker.worktree_dir
    ) {
      const ref = { repoRoot: worker.worktree_from, worktreeDir: worker.worktree_dir, branch: worker.branch, workerId: params.id };
      void c.branchIntegration.apply(ref).then((result) => {
        if (result.ok) {
          c.events.append(params.id, c.clock.now(), "try_applied", {
            branch: ref.branch, files: result.files, lockfileChanged: result.lockfileChanged, auto: true,
          });
          c.bus.publish("worker:change", { workerId: params.id });
        } else {
          c.log.warn("auto-apply skipped", { worker: params.id, reason: result.reason, detail: result.detail });
        }
      }).catch((e) => c.log.warn("auto-apply failed", { worker: params.id, error: errMsg(e) }));
    }
    try {
      // The parent records the worker_report event itself when the report
      // lands in its transcript — see DispatchMessage header for why a
      // dispatch-time append misorders against the parent's in-flight turn.
      await c.httpWorkerClient.sendMessage(parent.port, formatted, {
        as: "worker_report", fromWorker: params.id, workerName: label, displayText: body.text,
      });
      transitionState(
        { workers: c.workers, events: c.events, bus: c.bus, clock: c.clock },
        { workerId: worker.parent_id, next: "WORKING", reason: "worker_report" },
      );
      c.bus.publish("worker:change", { workerId: worker.parent_id });
      writeJson(res, 200, { ok: true, delivered: true });
    } catch (e) {
      c.log.warn("report delivery failed", { worker: params.id, parent: worker.parent_id, error: errMsg(e) });
      writeJson(res, 200, { ok: true, delivered: false });
    }
  });

  r.put(/^\/workers\/(?<id>[^/]+)\/name$/, async ({ params, req, res }) => {
    const body = validate(SetNameRequestSchema, await readBody(req));
    const worker = c.workers.findById(params.id);
    if (!worker) { writeJson(res, 404, { error: "not found" }); return; }
    c.workers.updateName(params.id, body.name);
    c.bus.publish("worker:change", { workerId: params.id });
    writeJson(res, 200, { ok: true });
  });

  r.put(/^\/workers\/(?<id>[^/]+)\/permission$/, async ({ params, req, res }) => {
    const body = validate(SetPermissionRequestSchema, await readBody(req));
    const out = await setWorkerPermissionMode(
      {
        workers: c.workers, events: c.events, bus: c.bus, clock: c.clock,
        client: c.httpWorkerClient, log: c.log,
      },
      { workerId: params.id, mode: body.mode, cascade: body.cascade },
    );
    writeJson(res, 200, { ok: true, ...out });
  });

  r.put(/^\/workers\/(?<id>[^/]+)\/model$/, async ({ params, req, res }) => {
    const body = validate(SetModelRequestSchema, await readBody(req));
    const out = await setWorkerModel(
      {
        workers: c.workers, events: c.events, bus: c.bus, clock: c.clock,
        client: c.httpWorkerClient, log: c.log, caps: c.modelCatalog,
      },
      { workerId: params.id, model: body.model, effort: body.effort },
    );
    writeJson(res, 200, { ok: true, ...out });
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/diff$/, async ({ params, res }) => {
    // Return 200+zeros for both "missing worker" and "no cwd" so a poll that
    // races with a kill doesn't fire a 404 in the network log. Frontend
    // already treats zero stats as "nothing to show".
    const w = c.workers.findById(params.id);
    const cwd = gitDirOf(w);
    if (!cwd) { writeJson(res, 200, { insertions: 0, deletions: 0, files: 0 }); return; }
    const stat = await c.git.diffShortStat(cwd, await diffBaseOf(c, w));
    writeJson(res, 200, stat);
  });

  // Read-only push readiness — the SAME decidePushPlan the POST /push action
  // runs, so the UI's Push-button visibility shares one source of truth. NOT
  // gated on the fork-base diff (which counts committed work as dirty and hides
  // Push on local-only worktrees); `hasUncommitted` is the real clean-tree gate.
  r.get(/^\/workers\/(?<id>[^/]+)\/push-state$/, async ({ params, res }) => {
    const w = c.workers.findById(params.id);
    const dir = gitDirOf(w);
    if (!dir) {
      writeJson(res, 200, {
        branch: null, remote: null, hasUpstream: false,
        ahead: 0, behind: 0, kind: "blocked", pushable: false, hasUncommitted: false,
      });
      return;
    }
    const [state, hasUncommitted] = await Promise.all([
      c.git.pushState(dir),
      c.git.hasUncommittedChanges(dir),
    ]);
    const plan = decidePushPlan(state);
    writeJson(res, 200, {
      branch: state.branch,
      remote: state.remote,
      hasUpstream: state.hasUpstream,
      ahead: state.ahead,
      behind: state.behind,
      kind: plan.kind,
      pushable: isActionablePushPlan(plan),
      hasUncommitted,
    });
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/changes$/, async ({ params, res }) => {
    // Same 200+empty convention as /diff above.
    const w = c.workers.findById(params.id);
    const dir = gitDirOf(w);
    if (!dir) { writeJson(res, 200, { files: [], insertions: 0, deletions: 0 }); return; }
    const files = await c.git.changedFiles(dir, await diffBaseOf(c, w));
    writeJson(res, 200, {
      files,
      insertions: files.reduce((n, f) => n + (f.insertions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    });
  });

  // ---- Try (unstaged apply) -------------------------------------------------
  // The daemon applies the worker branch's merged result into the USER'S
  // checkout (worktree_from) as working-tree-only edits. Mutating routes
  // require the per-boot UI token so agents holding EOS_DAEMON_URL
  // cannot self-apply. 409 until worktree_dir enrichment lands — acting on
  // worktree_from alone would snapshot the wrong tree.

  const uiTokenOk = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
    req.headers["x-eos-ui-token"] === c.uiToken;

  const tryRefOf = (id: string): { ref?: { repoRoot: string; worktreeDir: string | null; branch: string; workerId: string }; status: number; error?: string } => {
    const w = c.workers.findById(id);
    if (!w) return { status: 404, error: "worker not found" };
    if (!w.worktree_from || !w.branch) return { status: 409, error: "worker has no worktree branch" };
    if (!w.worktree_dir) return { status: 409, error: "worktree not registered yet — retry shortly" };
    return { status: 200, ref: { repoRoot: w.worktree_from, worktreeDir: w.worktree_dir, branch: w.branch, workerId: id } };
  };

  r.get(/^\/workers\/(?<id>[^/]+)\/try\/preview$/, async ({ params, res }) => {
    const t = tryRefOf(params.id);
    if (!t.ref) { writeJson(res, t.status, { error: t.error }); return; }
    writeJson(res, 200, await c.branchIntegration.preview(t.ref));
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/try\/state$/, async ({ params, res }) => {
    const w = c.workers.findById(params.id);
    if (!w) { writeJson(res, 404, { error: "worker not found" }); return; }
    const repoRoot = w.worktree_from ?? w.cwd;
    if (!repoRoot) { writeJson(res, 200, { activeTry: null, kept: false }); return; }
    writeJson(res, 200, {
      activeTry: await c.branchIntegration.activeTry(repoRoot),
      kept: await c.branchIntegration.wasKept({ repoRoot, workerId: params.id }),
    });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/try$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const t = tryRefOf(params.id);
    if (!t.ref) { writeJson(res, t.status, { error: t.error }); return; }
    const result = await c.branchIntegration.apply(t.ref);
    if (result.ok) {
      c.events.append(params.id, c.clock.now(), "try_applied", {
        branch: t.ref.branch, files: result.files, lockfileChanged: result.lockfileChanged,
      });
      c.bus.publish("worker:change", { workerId: params.id });
      writeJson(res, 200, { ok: true, files: result.files, lockfileChanged: result.lockfileChanged });
      return;
    }
    writeJson(res, 409, { ok: false, reason: result.reason, files: result.files, detail: result.detail });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/try\/keep$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const w = c.workers.findById(params.id);
    const repoRoot = w?.worktree_from ?? w?.cwd;
    if (!repoRoot) { writeJson(res, 404, { error: "worker not found" }); return; }
    const active = await c.branchIntegration.activeTry(repoRoot);
    const result = await c.branchIntegration.keep(repoRoot);
    if (result.ok && active) {
      c.events.append(active.workerId, c.clock.now(), "try_kept", { branch: active.branch, files: active.files });
      c.bus.publish("worker:change", { workerId: active.workerId });
    }
    writeJson(res, result.ok ? 200 : 409, result);
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/try\/discard$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const w = c.workers.findById(params.id);
    const repoRoot = w?.worktree_from ?? w?.cwd;
    if (!repoRoot) { writeJson(res, 404, { error: "worker not found" }); return; }
    const active = await c.branchIntegration.activeTry(repoRoot);
    const result = await c.branchIntegration.discard(repoRoot);
    if (result.ok && active) {
      c.events.append(active.workerId, c.clock.now(), "try_discarded", { branch: active.branch, files: active.files });
      c.bus.publish("worker:change", { workerId: active.workerId });
    }
    writeJson(res, result.ok ? 200 : 409, result);
  });

  // ---- Terminal (composer `!` mode) ----------------------------------------
  // Daemon-side shell in the worker's working dir — no agent turn, no worker
  // state change. UI-token gated: without it a policy-restricted agent holding
  // EOS_DAEMON_URL would have a policy-free exec path.

  r.post(/^\/workers\/(?<id>[^/]+)\/terminal$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(TerminalRunRequestSchema, await readBody(req));
    const w = c.workers.findById(params.id);
    if (!w) { writeJson(res, 404, { error: "worker not found" }); return; }
    const cwd = gitDirOf(w);
    if (!cwd) { writeJson(res, 400, { error: "worker has no working directory" }); return; }
    writeJson(res, 200, c.terminalRuns.run(params.id, cwd, body.command));
  });

  // Workspace-scoped variant (no agent selected): explicit cwd, nothing
  // persists — output is ephemeral SSE only.
  r.post("/terminal", async ({ req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(WorkspaceTerminalRunRequestSchema, await readBody(req));
    const cwd = expandPath(body.cwd);
    if (!cwd || !existsSync(cwd)) { writeJson(res, 400, { error: "cwd does not exist" }); return; }
    writeJson(res, 200, c.terminalRuns.run(null, cwd, body.command));
  });

  // Kill is runId-scoped — one route serves worker and workspace runs alike.
  r.post(/^\/terminal\/(?<runId>[^/]+)\/kill$/, ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    writeJson(res, 200, { ok: c.terminalRuns.kill(params.runId) });
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/changes\/file$/, async ({ params, url, res }) => {
    const q = validate(FileDiffQuerySchema, {
      path: url.searchParams.get("path") ?? undefined,
      oldPath: url.searchParams.get("oldPath") ?? undefined,
    });
    if (q.path.startsWith("/") || q.path.split("/").includes("..")) {
      writeJson(res, 400, { error: "path must be repo-relative" });
      return;
    }
    const w = c.workers.findById(params.id);
    const dir = gitDirOf(w);
    if (!dir) { writeJson(res, 200, { path: q.path, patch: "", binary: false, truncated: false }); return; }
    writeJson(res, 200, await c.git.fileDiff(dir, q.path, q.oldPath, await diffBaseOf(c, w)));
  });
}
