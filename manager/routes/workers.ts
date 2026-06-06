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
} from "../../contracts/src/http.ts";

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
import { resolveWorkerAction } from "../services/worker-actions.ts";

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
    const spec = {
      ...body,
      cwd: expandPath(body.cwd),
      worktreeFrom: expandPath(body.worktreeFrom),
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
        logFileFor: c.logFileFor,
        backend,
        onAgentEvent: c.onAgentEvent,
        recents: c.recents,
      },
      spec,
    );
    if (isGitAgent && body.prompt) {
      c.events.append(result.id, c.clock.now(), "user_message", { text: body.prompt });
      c.bus.publish("worker:change", { workerId: result.id });
    }
    writeJson(res, 201, result);
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
        bus: c.bus,
        supervisor: c.supervisor,
        log: c.log,
        findOrphanPids: (safeName) => supervisorWithFind.findPidsByPattern(`cm-${safeName}-`),
        postKillCleanup: (id) => {
          c.cleanupMcpConfig(id);
        },
        cleanupWorktree: (ref) => {
          void c.worktrees.remove(ref).catch((e) => c.log.warn("worktree cleanup failed", { worker: params.id, error: errMsg(e) }));
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
    });
    const rows = c.events.list({ workerId: params.id, since: q.since, limit: q.limit, order: q.order });
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
    writeJson(res, 200, { ok: true });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const raw = await readBody(req) as { text?: string; fromParent?: string };
    const body = validate(MessageRequestSchema, raw);
    const fromParent = typeof raw.fromParent === "string" ? raw.fromParent : null;

    if (fromParent) {
      c.turnSettle.clear(params.id);
      const worker = c.workers.findById(params.id);
      if (!worker?.port) { writeJson(res, 404, { error: "worker not found" }); return; }
      const parent = c.workers.findById(fromParent);
      const parentName = parent?.name ?? fromParent;
      try {
        await c.httpWorkerClient.sendMessage(worker.port, body.text);
      } catch (e) {
        writeJson(res, 502, { error: "worker unreachable" }); return;
      }
      c.events.append(params.id, c.clock.now(), "orchestrator_message", {
        text: body.text, fromParent, parentName,
      });
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
      {
        workers: c.workers, events: c.events, bus: c.bus, clock: c.clock,
        client: c.httpWorkerClient,
        backends: c.backends,
        log: c.log,
        isLive: (id) => c.supervisor.has(id),
        excerptLimit: 200,
      },
      { workerId: params.id, text: body.text },
    );
    writeJson(res, result.status, result.body);
  });

  // Predefined action → resolve the prompt template server-side; the chat
  // shows only the short display label (the full prompt never reaches the UI).
  r.post(/^\/workers\/(?<id>[^/]+)\/action$/, async ({ params, req, res }) => {
    const body = validate(WorkerActionRequestSchema, await readBody(req));
    const { prompt, display } = resolveWorkerAction(c.promptTemplates, body.action);
    c.turnSettle.clear(params.id);
    const result = await dispatchMessage(
      {
        workers: c.workers, events: c.events, bus: c.bus, clock: c.clock,
        client: c.httpWorkerClient,
        backends: c.backends,
        log: c.log,
        isLive: (id) => c.supervisor.has(id),
        excerptLimit: 200,
      },
      { workerId: params.id, text: prompt, displayText: display },
    );
    writeJson(res, result.status, result.body);
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

  // Web UI posts answers here. The answer is delivered to Claude as keystrokes
  // into its native menu; this call records it so the banner dismisses durably
  // (and resolves any legacy blocking long-poll — a no-op in the keystroke flow).
  r.post(/^\/workers\/(?<id>[^/]+)\/question-answer$/, async ({ params, req, res }) => {
    const body = validate(QuestionAnswerRequestSchema, await readBody(req));
    c.pendingQuestions.resolveByToolUseId(params.id, body.toolUseId, body.answers);
    c.events.append(params.id, c.clock.now(), "question_answered", {
      toolUseId: body.toolUseId,
      answers: body.answers,
    });
    c.bus.publish("worker:change", { workerId: params.id });
    writeJson(res, 200, { ok: true });
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

  r.post(/^\/workers\/(?<id>[^/]+)\/interrupt$/, ({ params, res }) => {
    const worker = c.workers.findById(params.id);
    if (!worker?.port) { writeJson(res, 404, { error: "worker not found" }); return; }
    if (!c.supervisor.has(params.id)) { writeJson(res, 409, { error: "worker not running" }); return; }
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
    const formatted = `[worker ${label} (${params.id})] reported:\n${body.text}`;
    try {
      await c.httpWorkerClient.sendMessage(parent.port, formatted);
      c.events.append(worker.parent_id, c.clock.now(), "worker_report", {
        text: body.text, fromWorker: params.id, workerName: label,
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
        client: c.httpWorkerClient, log: c.log,
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
    const cwd = w ? (w.worktree_from ?? w.cwd) : null;
    if (!w || !cwd) { writeJson(res, 200, { insertions: 0, deletions: 0, files: 0 }); return; }
    const stat = await c.git.diffShortStat(cwd);
    writeJson(res, 200, stat);
  });
}
