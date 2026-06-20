import { existsSync } from "node:fs";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import {
  EventsQuerySchema,
  MessageRequestSchema,
  ReportRequestSchema,
  SetNameRequestSchema,
  SetPermissionRequestSchema,
  SetModelRequestSchema,
  SetBackendRequestSchema,
  QuestionRequestSchema,
  QuestionAnswerRequestSchema,
  PeerRequestRegisterRequestSchema,
  PeerResponseRequestSchema,
  NotifyRequestSchema,
  WorkerActionRequestSchema,
  RewindRequestSchema,
  FileDiffQuerySchema,
  TerminalRunRequestSchema,
  TryTargetRequestSchema,
  WorkspaceTerminalRunRequestSchema,
  OpenInRequestSchema,
  ResolveConflictRequestSchema,
  WorkerChangesDiscardRequestSchema,
  type OpenInRequest,
} from "../../contracts/src/http.ts";
import type { WorkerRow } from "../../contracts/src/worker.ts";

import { dispatchMessage } from "../../core/src/use-cases/DispatchMessage.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { processWorkerEvent } from "../../core/src/use-cases/ProcessWorkerEvent.ts";
import { toCanonicalEvents } from "../../spawner/canonical-map.ts";
import { setWorkerPermissionMode } from "../../core/src/use-cases/SetWorkerPermissionMode.ts";
import { assertOwnedBy } from "../../core/src/services/WorkerOwnership.ts";
import { assertPeers, listPeersOf, isConsultable } from "../../core/src/services/Peers.ts";
import { setWorkerModel } from "../../core/src/use-cases/SetWorkerModel.ts";
import { expandPath } from "../shared/path.ts";
import { appendSynthesized } from "../shared/synthesized-events.ts";
import { resumeWorkerVia, resumeIfDead, switchWorkerBackend } from "./resume-helpers.ts";
import { dispatchDeps } from "./dispatch-deps.ts";
import { reportHoldGate } from "./report-hold.ts";
import { formatWorkerReport } from "../shared/worker-report.ts";
import { resolveWorkerAction } from "../services/worker-actions.ts";
import { pushBranch } from "../../core/src/use-cases/PushBranch.ts";
import { pullBranch } from "../../core/src/use-cases/PullBranch.ts";
import { listConflicts } from "../../core/src/use-cases/ListConflicts.ts";
import { getConflictDocument } from "../../core/src/use-cases/GetConflictDocument.ts";
import { resolveConflictFile } from "../../core/src/use-cases/ResolveConflictFile.ts";
import { discardFileChange } from "../../core/src/use-cases/DiscardFileChange.ts";
import { decidePushPlan, isActionablePushPlan } from "../../core/src/domain/push-plan.ts";
import { decidePullPlan, isActionablePullPlan } from "../../core/src/domain/pull-plan.ts";
import { attachPatches, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES } from "../../infra/src/git/changes-parse.ts";

// Window in which a SessionEnd(clear) hook is treated as a duplicate of a
// conversation_cleared the /clear slash command just appended (command → hook
// latency is sub-second; this covers it without suppressing a later real clear).
const CLEAR_HOOK_DEDUP_MS = 30_000;

// Where the agent actually edits: the worktree dir when spawned with a
// worktree (cwd is NULL for those rows), plain cwd otherwise. worktree_from
// only as fallback for the window before worktree_dir enrichment lands.
function gitDirOf(w: WorkerRow | null): string | null {
  return w ? (w.worktree_dir ?? w.cwd ?? w.worktree_from ?? null) : null;
}

// Read-side variant for git queries (/diff, /changes, /push-state): a fresh
// worktree row is complete at insert (precomputed worktree_dir) but the tree
// materializes during worker boot. Reading the dir before workspace_ready
// flips is actively wrong — `git -C` against a missing dir fails to zeros,
// against a dir without .git walks UP and reports the SOURCE repo's diff as
// this worker's, and against a mid-checkout tree reports mass deletions.
// Fail closed to the existing 200+empty convention instead.
function readableGitDirOf(w: WorkerRow | null): string | null {
  if (w?.worktree_from && w.worktree_dir && !w.workspace_ready) return null;
  return gitDirOf(w);
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

// Surface a worker's live background processes (Monitor / `Bash
// run_in_background`) on its row for the corner activity widget — but only
// while the worker is alive, since those processes die with it. Runtime view
// state from the in-memory service; never persisted.
function withBackgroundActivity(c: Container, rows: WorkerRow[]): WorkerRow[] {
  return rows.map((w) => {
    // Only while the agent is actively working — a turn-scoped indicator. On
    // IDLE the turn is over; Monitor/bg-bash run async and their real finish
    // isn't observable, so we stop surfacing them instead of leaving them stuck.
    const alive = w.state === "WORKING" || w.state === "SPAWNING";
    const bg = alive ? c.backgroundActivity.forWorker(w.id) : [];
    return bg.length ? { ...w, backgroundActivity: bg } : w;
  });
}

// The orchestrator's (or user's) message reached a worker paused on needs-input:
// the answer arrived, so clear awaiting_input and let the goal-gate resume its
// normal tick on the next IDLE. No-op when the worker has no active loop.
function resumeLoopOnInput(c: Container, workerId: string): void {
  const loop = c.loops.findActiveByWorker(workerId);
  if (loop?.awaitingInput) c.loops.setAwaitingInput(loop.id, false);
}

// Surface a worker's active dynamic loop. Ungated on state — a loop sits IDLE
// between iterations, so attach it whenever findActiveByWorker is non-null.
function withLoopState(c: Container, rows: WorkerRow[]): WorkerRow[] {
  return rows.map((w) => {
    const l = c.loops.findActiveByWorker(w.id);
    return l ? { ...w, loop: { status: l.status, attempt: l.attempt, maxAttempts: l.maxAttempts, lastReason: l.lastReason, goalSummary: l.goal.summary ?? null } } : w;
  });
}


export function registerWorkerRoutes(r: Router, c: Container): void {
  r.get("/workers", ({ url, res }) => {
    const parentId = url.searchParams.get("parentId");
    const rows = parentId ? c.workers.listByParent(parentId) : c.workers.listAll();
    writeJson(res, 200, withLoopState(c, withBackgroundActivity(c, rows)));
  });

  // worker.spawn (POST /workers) is served by the command catalog —
  // manager/commands/handlers/spawn-worker.ts.

  r.get(/^\/workers\/(?<id>[^/]+)$/, ({ params, url, res }) => {
    const actorId = url.searchParams.get("actorId");
    if (actorId) assertOwnedBy(c.workers, actorId, params.id, { allowSelf: true });
    const row = c.workers.findById(params.id);
    if (!row) { writeJson(res, 404, { error: "not found" }); return; }
    writeJson(res, 200, withLoopState(c, [row])[0]);
  });

  // worker.kill (DELETE /workers/:id) is served by the command catalog —
  // manager/commands/handlers/kill-worker.ts.

  r.get(/^\/workers\/(?<id>[^/]+)\/events$/, ({ params, url, res }) => {
    const q = validate(EventsQuerySchema, {
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      order: url.searchParams.get("order") ?? undefined,
      beforeId: url.searchParams.get("beforeId") ?? undefined,
      afterId: url.searchParams.get("afterId") ?? undefined,
    });
    const rows = c.events.list({ workerId: params.id, since: q.since, limit: q.limit, order: q.order, beforeId: q.beforeId, afterId: q.afterId });
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
    // Corner activity widget: track Monitor / `Bash run_in_background` starts
    // (tool_running) and their shell-id replies (tool_done). Manager-side view
    // state, deliberately kept out of ProcessWorkerEvent (core) — OCP.
    if (body.type === "tool_running") {
      const p = body.payload as { toolName?: string; toolUseId?: string | null; input?: Record<string, unknown> } | undefined;
      if (p?.toolName) c.backgroundActivity.onToolRunning(params.id, p.toolName, p.toolUseId ?? null, p.input ?? {});
    } else if (body.type === "tool_done") {
      const p = body.payload as { toolName?: string; toolUseId?: string | null; result?: string } | undefined;
      if (p?.toolName) c.backgroundActivity.onToolDone(params.id, p.toolName, p.toolUseId ?? null, p.result ?? "");
    } else if (body.type === "hook") {
      // Turn/session ended → clear this worker's background activity. Monitor /
      // `Bash run_in_background` are async: their real finish isn't observable
      // (tool_done fires ~200ms after start, at arm time, not completion), so we
      // drop them when the turn that started them ends — a turn-scoped indicator
      // instead of a stuck entry.
      const ev = (body.payload as { event?: string } | undefined)?.event;
      if (ev === "Stop" || ev === "SessionEnd") c.backgroundActivity.clearWorker(params.id);
    }
    // /clear marker: mirror of conversation_rewound — the web hides everything
    // before it. Synthesized here because the signal arrives as a plain hook.
    const hp = body.payload as { event?: string; body?: { reason?: string; session_id?: string } } | undefined;
    if (body.type === "hook" && hp?.event === "SessionEnd" && hp?.body?.reason === "clear") {
      // The /clear slash command (dispatch chokepoint) now owns these side effects
      // and runs them on BOTH backends. This hook is the idempotent FALLBACK for a
      // clear that did not come through the command (the agent self-runs /clear, an
      // attached terminal) — skip when the command already appended the marker so
      // the queue isn't double-cleared and no second conversation_cleared lands.
      const recent = c.events.list({ workerId: params.id, since: 0, limit: 8, order: "desc" });
      const alreadyHandled = recent.some(
        (e) => e.type === "conversation_cleared" && c.clock.now() - e.ts < CLEAR_HOOK_DEDUP_MS,
      );
      if (alreadyHandled) {
        c.log.info("/clear hook skipped — already handled by slash command", { workerId: params.id });
      } else {
        // Same cancel semantics as interrupt: messages queued against the old
        // conversation must not drain into the fresh context at the next IDLE.
        const clearedQueued = c.messageQueue.clearPending(params.id);
        if (clearedQueued > 0) c.log.info("/clear cleared queued messages", { workerId: params.id, count: clearedQueued });
        // A fresh context drops any peer consultations this worker had outstanding.
        c.pendingPeerRequests.cancelByWorker(params.id);
        appendSynthesized(c, params.id, "conversation_cleared", {
          prevSessionId: hp.body?.session_id ?? null,
        });
      }
    }
    writeJson(res, 200, { ok: true });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const raw = await readBody(req) as { text?: string; fromParent?: string };
    const body = validate(MessageRequestSchema, raw);
    const fromParent = typeof raw.fromParent === "string" ? raw.fromParent : null;

    const target = c.workers.findById(params.id);
    if (!target) { writeJson(res, 404, { error: "worker not found" }); return; }
    // Scope check before any side effect — a denied foreign message must not
    // resume a dead worker or clear its settle window.
    if (fromParent) assertOwnedBy(c.workers, fromParent, params.id);
    await resumeIfDead(c, target);

    if (fromParent) {
      const parent = c.workers.findById(fromParent);
      const parentName = parent?.name ?? fromParent;
      try {
        // Backend-aware: routes through the AgentBackend the worker runs on, so a
        // port-less in-process (claude-sdk) worker is reachable too — the old
        // direct httpWorkerClient.sendMessage(worker.port,…) 404'd for them. The
        // PTY worker self-reports orchestrator_message at its transcript sighting;
        // in-process gets the daemon-side append. dispatchMessage also gives the
        // directive the dashboard path's WORKING lift + settle-clear.
        await dispatchMessage(dispatchDeps(c), {
          workerId: params.id, text: body.text,
          envelope: { kind: "orchestrator_message", fromParent, parentName },
          // Busy worker → hold in the daemon queue and deliver at its next IDLE
          // (fully verified delivery), exactly like worker_report. A direct
          // mid-turn PTY steer skips ACK + retry (delivery.ts isTurnActive) and
          // is silently lost if the CR doesn't take — and nothing redelivers it
          // after the turn ends, because only queued rows drain at IDLE. The
          // tool's own prompt already promises "your message will queue".
          queueWhenBusy: true,
          origin: "orchestrator-directive",
        });
      } catch (e) {
        writeJson(res, 502, { error: "worker unreachable" }); return;
      }
      resumeLoopOnInput(c, params.id);
      const worker = c.workers.findById(params.id);
      writeJson(res, 200, { ok: true, id: params.id, name: worker?.name ?? null });
      return;
    }

    const result = await dispatchMessage(
      dispatchDeps(c),
      {
        workerId: params.id, text: body.text,
        clientMsgId: body.clientMsgId, queueWhenBusy: body.queueWhenBusy,
        origin: "dashboard",
      },
    );
    if (result.status < 300) resumeLoopOnInput(c, params.id);
    writeJson(res, result.status, result.body);
  });

  // Daemon-side message queue — pills render from this; dismiss deletes a
  // still-pending row (a drained row is gone from the pending list already).
  // User-plane ONLY: agent-plane traffic (a worker report queued behind a busy
  // parent) drains into the transcript at the next IDLE and must never surface
  // as a pill in the user's composer.
  r.get(/^\/workers\/(?<id>[^/]+)\/queue$/, ({ params, res }) => {
    const rows = c.messageQueue.listPendingUserPlane(params.id);
    writeJson(res, 200, { messages: rows.map((m) => ({ id: m.id, text: m.displayText ?? m.text, ts: m.createdAt })) });
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
    const { prompt, display } = resolveWorkerAction(c.prompts, body.action);
    const target = c.workers.findById(params.id);
    if (!target) { writeJson(res, 404, { error: "worker not found" }); return; }
    await resumeIfDead(c, target);
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
    appendSynthesized(c, params.id, "git_push", result);
    writeJson(res, 200, result);
  });

  // ask_user registration — the orchestrator's MCP tool posts the questions,
  // gets a questionId back immediately, and polls the GET below until the
  // operator answers in the web banner. No tool_use_id exists on this path,
  // so synthesize one when absent — the banner and the answer round-trip key
  // off it, and a unique id keeps concurrent questions from superseding each
  // other.
  r.post(/^\/workers\/(?<id>[^/]+)\/question$/, async ({ params, req, res }) => {
    const body = validate(QuestionRequestSchema, await readBody(req));
    const toolUseId = body.toolUseId || c.ids.newPendingId();

    const { questionId } = c.pendingQuestions.register(params.id, toolUseId);
    appendSynthesized(c, params.id, "question_pending", {
      toolUseId,
      questions: body.questions,
    });
    // The asker is blocked inside its tool call and cannot notify_user itself;
    // fire the background tap here (native app delivers only when backgrounded).
    c.bus.publish("notification:fire", {
      title: "Input needed",
      body: body.questions[0]?.question ?? "A question is waiting in the dashboard.",
      workerId: params.id,
      ts: c.clock.now(),
    });
    writeJson(res, 200, { questionId, toolUseId });
  });

  // Poll — always 200; the tool routes on `status` ("gone" = daemon restarted,
  // worker killed, or superseded — the registry is in-memory by design).
  r.get(/^\/workers\/(?<id>[^/]+)\/question\/(?<questionId>[^/]+)$/, ({ params, res }) => {
    const state = c.pendingQuestions.poll(params.questionId);
    writeJson(res, 200, state.status === "answered"
      ? { status: state.status, answers: state.answers }
      : { status: state.status });
  });

  // Web UI posts the operator's answers (or a dismissal) here. The polling
  // ask_user tool picks the terminal state up on its next poll; the
  // question_answered event dismisses the banner durably either way.
  r.post(/^\/workers\/(?<id>[^/]+)\/question-answer$/, async ({ params, req, res }) => {
    const body = validate(QuestionAnswerRequestSchema, await readBody(req));
    const settled = body.dismissed
      ? c.pendingQuestions.dismissByToolUseId(params.id, body.toolUseId)
      : c.pendingQuestions.resolveByToolUseId(params.id, body.toolUseId, body.answers ?? {});
    appendSynthesized(c, params.id, "question_answered", {
      toolUseId: body.toolUseId,
      answers: body.answers ?? {},
      ...(body.dismissed ? { dismissed: true } : {}),
    });
    writeJson(res, 200, { ok: true, outcome: settled ? (body.dismissed ? "dismissed" : "answered") : "gone" });
  });

  // ---- Peer consultation (worker ↔ worker) ---------------------------------

  // list_peers — the collaborate-enabled, still-alive siblings :id may consult.
  r.get(/^\/workers\/(?<id>[^/]+)\/peers$/, ({ params, res }) => {
    const peers = listPeersOf(c.workers, params.id).map((w) => ({
      id: w.id,
      name: w.name ?? null,
      state: w.state,
      summary: (w.prompt ?? "").split("\n")[0].slice(0, 160),
    }));
    writeJson(res, 200, peers);
  });

  // ask_peer registration — :id is the TARGET peer; fromWorker is the asker. The
  // PeerRequestPump delivers the question into the target's PTY at its next IDLE
  // and the asker polls the GET below until answered/declined/gone.
  r.post(/^\/workers\/(?<id>[^/]+)\/peer-request$/, async ({ params, req, res }) => {
    const body = validate(PeerRequestRegisterRequestSchema, await readBody(req));
    // Scope: asker and target must be collaboration peers (siblings, both opted in).
    assertPeers(c.workers, body.fromWorker, params.id);
    const target = c.workers.findById(params.id);
    if (!target || !isConsultable(target)) {
      writeJson(res, 200, { declined: true, reason: `peer ${target?.name ?? params.id} is not available to consult right now` });
      return;
    }
    // A worker blocked in ask_peer is mid-turn (never IDLE), so a circular wait
    // would deadlock the pump's auto-decline. Reject it at registration.
    if (c.pendingPeerRequests.wouldDeadlock(body.fromWorker, params.id)) {
      writeJson(res, 200, { declined: true, reason: `consulting ${target.name ?? params.id} would create a circular wait — answer from what you already have, or restructure` });
      return;
    }
    const { requestId } = c.pendingPeerRequests.register(body.fromWorker, params.id, body.question);
    // Durable "consulting <peer>" marker on the asker's timeline (the ask_peer
    // tool call also renders, but resolves only when the answer returns).
    // Nudge the pump via the target's worker:change — if the target is sitting
    // IDLE it delivers now; otherwise the request waits for its next IDLE.
    // pumpPeerFor self-guards on state, so the synthetic change is safe.
    appendSynthesized(c, body.fromWorker, "peer_consult", {
      requestId, toWorker: params.id, toName: target.name ?? null, question: body.question,
    }, params.id);
    writeJson(res, 200, { requestId });
  });

  // Poll — always 200; the asker's ask_peer tool routes on `status` (queued and
  // delivered both surface as "pending"; "gone" = peer died / asker interrupted
  // / daemon restarted).
  r.get(/^\/workers\/(?<id>[^/]+)\/peer-request\/(?<requestId>[^/]+)$/, ({ params, res }) => {
    writeJson(res, 200, c.pendingPeerRequests.poll(params.requestId));
  });

  // respond_to_peer — :id is the responder; it resolves the single delivered
  // request addressed to it (at most one in-flight), so no requestId is needed.
  r.post(/^\/workers\/(?<id>[^/]+)\/peer-response$/, async ({ params, req, res }) => {
    const body = validate(PeerResponseRequestSchema, await readBody(req));
    const resolved = c.pendingPeerRequests.resolveDelivered(params.id, body.answer);
    const asker = resolved ? c.workers.findById(resolved.from) : null;
    writeJson(res, 200, {
      ok: true,
      outcome: resolved ? "answered" : "none",
      ...(resolved ? { toWorker: resolved.from, toName: asker?.name ?? null } : {}),
    });
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
      appendSynthesized(c, params.id, "conversation_rewound", {
        uuid: result.uuid,
        text: result.text,
        display: result.display,
        index: result.index,
        mode: body.mode,
      });
    }
    writeJson(res, 200, result);
  });

  // worker.interrupt (POST /workers/:id/interrupt) is served by the command
  // catalog — manager/commands/handlers/interrupt-worker.ts.

  r.post(/^\/workers\/(?<id>[^/]+)\/report$/, async ({ params, req, res }) => {
    const body = validate(ReportRequestSchema, await readBody(req));
    const worker = c.workers.findById(params.id);
    if (!worker) { writeJson(res, 404, { error: "worker not found" }); return; }
    if (!worker.parent_id) { writeJson(res, 400, { error: "worker has no parent" }); return; }

    c.bus.publish("worker:report", { workerId: params.id, parentId: worker.parent_id });

    // Report-hold gate (R7): a looped worker's terminal report is held until its
    // goal-check passes (the goal tick, after this turn ends, releases or
    // discards it). needs-input always passes through.
    if (reportHoldGate(c.loops, params.id, body.text, { retryOnFailed: c.config.loop.retryOnFailed }).held) {
      c.bus.publish("loop:change", { workerId: params.id, status: "active" });
      writeJson(res, 200, { ok: true, delivered: false, held: true });
      return;
    }

    const parent = c.workers.findById(worker.parent_id);
    if (!parent) { writeJson(res, 200, { ok: true, delivered: false }); return; }
    // A report can wake a parent that suspended/finished while the worker ran
    // (daemon restart, an idle SDK session reaped) — same transparent resume
    // the dashboard path uses before dispatching.
    await resumeIfDead(c, parent);

    const label = worker.name ?? params.id;
    // Compliance-independent merge handle: the header carries the branch and
    // worktree even when the worker forgot its Handover line. Shared with the
    // loop release path so a held-then-released report is byte-identical.
    const formatted = formatWorkerReport(worker, body.text);

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
          appendSynthesized(c, params.id, "try_applied", {
            branch: ref.branch, files: result.files, lockfileChanged: result.lockfileChanged, auto: true,
          });
        } else {
          c.log.warn("auto-apply skipped", { worker: params.id, reason: result.reason, detail: result.detail });
        }
      }).catch((e) => c.log.warn("auto-apply failed", { worker: params.id, error: errMsg(e) }));
    }
    try {
      // Backend-aware delivery to the parent through its AgentBackend — a
      // port-less in-process (claude-sdk) orchestrator is reachable too (the old
      // direct httpWorkerClient.sendMessage(parent.port,…) silently dropped every
      // report to one). PTY parent self-reports worker_report at its transcript
      // sighting; in-process gets the daemon-side append. formatted = the routing
      // wrapper the parent reads; displayText = the bare body the chat renders.
      const result = await dispatchMessage(dispatchDeps(c), {
        workerId: worker.parent_id,
        text: formatted,
        displayText: body.text,
        envelope: { kind: "worker_report", fromWorker: params.id, workerName: label },
        // Fan-in serialization: N workers finishing together each get their own
        // orchestrator turn (FIFO, one per IDLE) instead of coalescing into one.
        // A report to a busy parent holds in the queue and drains at its next IDLE.
        queueWhenBusy: true,
        origin: "report",
      });
      writeJson(res, 200, { ok: true, delivered: result.status < 300 });
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
    const w = c.workers.findById(params.id);
    const kind = w?.backend_kind ?? "claude-cli";
    const backend = c.backends.has(kind) ? c.backends.get(kind) : c.claudeCliBackend;
    const out = await setWorkerModel(
      {
        workers: c.workers, events: c.events, bus: c.bus, clock: c.clock,
        backend, log: c.log, caps: c.modelCatalog,
      },
      { workerId: params.id, model: body.model, effort: body.effort },
    );
    writeJson(res, 200, { ok: true, ...out });
  });

  r.put(/^\/workers\/(?<id>[^/]+)\/backend$/, async ({ params, req, res }) => {
    const body = validate(SetBackendRequestSchema, await readBody(req));
    const out = await switchWorkerBackend(c, params.id, body.kind);
    writeJson(res, 200, { ok: true, ...out });
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/diff$/, async ({ params, res }) => {
    // Return 200+zeros for both "missing worker" and "no cwd" so a poll that
    // races with a kill doesn't fire a 404 in the network log. Frontend
    // already treats zero stats as "nothing to show".
    const w = c.workers.findById(params.id);
    const cwd = readableGitDirOf(w);
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
    const dir = readableGitDirOf(w);
    if (!dir) {
      writeJson(res, 200, {
        branch: null, remote: null, hasUpstream: false,
        ahead: 0, behind: 0, kind: "blocked", pushable: false, hasUncommitted: false,
        pullable: false, pullKind: "blocked",
      });
      return;
    }
    const [state, hasUncommitted] = await Promise.all([
      c.git.pushState(dir),
      c.git.hasUncommittedChanges(dir),
    ]);
    const plan = decidePushPlan(state);
    // Pull twin from the same probe — no extra git call (pushState already
    // carries branch + upstream + ahead/behind, which is the pull input).
    const pullPlan = decidePullPlan({
      branch: state.branch, hasUpstream: state.hasUpstream, ahead: state.ahead, behind: state.behind,
    });
    writeJson(res, 200, {
      branch: state.branch,
      remote: state.remote,
      hasUpstream: state.hasUpstream,
      ahead: state.ahead,
      behind: state.behind,
      kind: plan.kind,
      pushable: isActionablePushPlan(plan),
      hasUncommitted,
      pullable: isActionablePullPlan(pullPlan),
      pullKind: pullPlan.kind,
    });
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/changes$/, async ({ params, url, res }) => {
    // Same 200+empty convention as /diff above.
    const w = c.workers.findById(params.id);
    const dir = readableGitDirOf(w);
    if (!dir) { writeJson(res, 200, { files: [], insertions: 0, deletions: 0 }); return; }
    const base = await diffBaseOf(c, w);
    // ?patches=1 embeds per-file patches split from ONE whole-tree diff —
    // 2 git spawns total instead of 2 per file. fullDiff null (overflow) or a
    // missing/over-budget section ⇒ that file keeps lazy per-file loading.
    const wantPatches = url.searchParams.get("patches") === "1";
    const [files, full] = await Promise.all([
      c.git.changedFiles(dir, base),
      wantPatches ? c.git.fullDiff(dir, base) : Promise.resolve(null),
    ]);
    if (full !== null) attachPatches(files, full, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
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

  // Reject absolute paths and `..` traversal — every git path the UI sends is
  // repo-relative (same guard as the /changes/file route below).
  const repoRelative = (p: string): boolean => !!p && !p.startsWith("/") && !p.split("/").includes("..");

  const tryRefOf = (id: string): { ref?: { repoRoot: string; worktreeDir: string | null; branch: string; workerId: string }; status: number; error?: string } => {
    const w = c.workers.findById(id);
    if (!w) return { status: 404, error: "worker not found" };
    if (!w.worktree_from || !w.branch) return { status: 409, error: "worker has no worktree branch" };
    // workspace_ready, not just worktree_dir: the dir is precomputed at insert
    // and exists in the row long before the tree exists on disk.
    if (!w.worktree_dir || !w.workspace_ready) return { status: 409, error: "worktree not registered yet — retry shortly" };
    return { status: 200, ref: { repoRoot: w.worktree_from, worktreeDir: w.worktree_dir, branch: w.branch, workerId: id } };
  };

  // Deterministic pull — the worker-scoped twin of POST /push. Fast-forwards the
  // branch to its upstream when strictly behind; a diverged branch is reported,
  // never auto-merged (that is the git agent's job). UI-token gated because it
  // mutates the working tree; records a git_pull event for the chat history.
  r.post(/^\/workers\/(?<id>[^/]+)\/pull$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const w = c.workers.findById(params.id);
    if (!w) { writeJson(res, 404, { error: "worker not found" }); return; }
    const dir = gitDirOf(w);
    if (!dir) { writeJson(res, 400, { error: "worker has no working directory" }); return; }
    const result = await pullBranch({ git: c.git, remoteSync: c.remoteSync }, dir);
    appendSynthesized(c, params.id, "git_pull", result);
    writeJson(res, 200, result);
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/try\/preview$/, async ({ params, res }) => {
    const t = tryRefOf(params.id);
    if (!t.ref) { writeJson(res, t.status, { error: t.error }); return; }
    writeJson(res, 200, await c.branchIntegration.preview(t.ref));
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/try\/state$/, async ({ params, res }) => {
    const w = c.workers.findById(params.id);
    if (!w) { writeJson(res, 404, { error: "worker not found" }); return; }
    const repoRoot = w.worktree_from ?? w.cwd;
    if (!repoRoot) { writeJson(res, 200, { activeTries: [], kept: false, syncable: false, syncFiles: [] }); return; }
    // syncStatus needs the live worktree — only computed once it exists on disk
    // (same readiness gate as the apply routes); otherwise there is no anchor.
    const sync = (w.worktree_from && w.branch && w.worktree_dir && w.workspace_ready)
      ? await c.branchIntegration.syncStatus({ repoRoot: w.worktree_from, worktreeDir: w.worktree_dir, branch: w.branch, workerId: params.id })
      : { syncable: false, files: [] };
    writeJson(res, 200, {
      activeTries: await c.branchIntegration.activeTries(repoRoot),
      kept: await c.branchIntegration.wasKept({ repoRoot, workerId: params.id }),
      syncable: sync.syncable,
      syncFiles: sync.files,
    });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/try$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const t = tryRefOf(params.id);
    if (!t.ref) { writeJson(res, t.status, { error: t.error }); return; }
    const result = await c.branchIntegration.apply(t.ref);
    if (result.ok) {
      appendSynthesized(c, params.id, "try_applied", {
        branch: t.ref.branch, files: result.files, lockfileChanged: result.lockfileChanged,
      });
      writeJson(res, 200, { ok: true, files: result.files, lockfileChanged: result.lockfileChanged });
      return;
    }
    writeJson(res, 409, { ok: false, reason: result.reason, files: result.files, detail: result.detail });
  });

  // Keep/Discard target a specific layer via the body's workerId (the card's
  // owner — possibly a deleted worker); :id only resolves the repo.
  r.post(/^\/workers\/(?<id>[^/]+)\/try\/keep$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(TryTargetRequestSchema, await readBody(req));
    const w = c.workers.findById(params.id);
    const repoRoot = w?.worktree_from ?? w?.cwd;
    if (!repoRoot) { writeJson(res, 404, { error: "worker not found" }); return; }
    const active = (await c.branchIntegration.activeTries(repoRoot)).find((t) => t.workerId === body.workerId);
    const result = await c.branchIntegration.keep(repoRoot, body.workerId);
    if (result.ok && active) {
      appendSynthesized(c, active.workerId, "try_kept", { branch: active.branch, files: active.files });
    }
    writeJson(res, result.ok ? 200 : 409, result);
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/try\/discard$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(TryTargetRequestSchema, await readBody(req));
    const w = c.workers.findById(params.id);
    const repoRoot = w?.worktree_from ?? w?.cwd;
    if (!repoRoot) { writeJson(res, 404, { error: "worker not found" }); return; }
    const active = (await c.branchIntegration.activeTries(repoRoot)).find((t) => t.workerId === body.workerId);
    const result = await c.branchIntegration.discard(repoRoot, body.workerId);
    if (result.ok && active) {
      appendSynthesized(c, active.workerId, "try_discarded", { branch: active.branch, files: active.files });
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

  // Breadcrumb "Open in" — launches a host app on the agent's working dir.
  // The dir is resolved server-side from the row (never from the request).
  const OPEN_TARGETS: Record<OpenInRequest["target"], string[]> = {
    finder: [],
    vscode: ["-a", "Visual Studio Code"],
  };

  r.post(/^\/workers\/(?<id>[^/]+)\/open$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(OpenInRequestSchema, await readBody(req));
    const w = c.workers.findById(params.id);
    if (!w) { writeJson(res, 404, { error: "worker not found" }); return; }
    const dir = gitDirOf(w);
    if (!dir || !existsSync(dir)) { writeJson(res, 400, { error: "worker has no working directory" }); return; }
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("open", [...OPEN_TARGETS[body.target], dir]);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  // ---- Merge-conflict resolution (Fork-style) -------------------------------
  // Reads share the /changes 200+empty + readableGitDirOf gating. Resolve
  // writes a file + `git add`, so it is UI-token gated like /try and /terminal:
  // an agent holding EOS_DAEMON_URL must not get a policy-free write path.

  r.get(/^\/workers\/(?<id>[^/]+)\/conflicts$/, async ({ params, res }) => {
    const dir = readableGitDirOf(c.workers.findById(params.id));
    if (!dir) { writeJson(res, 200, { files: [] }); return; }
    writeJson(res, 200, await listConflicts({ git: c.git }, dir));
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/conflicts\/file$/, async ({ params, url, res }) => {
    const path = url.searchParams.get("path") ?? "";
    if (!repoRelative(path)) { writeJson(res, 400, { error: "path must be repo-relative" }); return; }
    const dir = readableGitDirOf(c.workers.findById(params.id));
    if (!dir) { writeJson(res, 404, { error: "worker has no working directory" }); return; }
    const doc = await getConflictDocument({ git: c.git }, dir, path);
    if (!doc) { writeJson(res, 404, { error: "not conflicted" }); return; }
    writeJson(res, 200, doc);
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/conflicts\/resolve$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(ResolveConflictRequestSchema, await readBody(req));
    if (!repoRelative(body.path)) { writeJson(res, 400, { error: "path must be repo-relative" }); return; }
    const dir = readableGitDirOf(c.workers.findById(params.id));
    if (!dir) { writeJson(res, 404, { error: "worker has no working directory" }); return; }
    const result = await resolveConflictFile({ git: c.git, conflicts: c.conflicts }, dir, body);
    if (result.ok) {
      appendSynthesized(c, params.id, "conflict_resolved", { path: body.path, remaining: result.remaining });
    }
    writeJson(res, result.ok ? 200 : 409, result);
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
    const dir = readableGitDirOf(w);
    if (!dir) { writeJson(res, 200, { path: q.path, patch: "", binary: false, truncated: false }); return; }
    writeJson(res, 200, await c.git.fileDiff(dir, q.path, q.oldPath, await diffBaseOf(c, w)));
  });

  // Discard ONE changed file back to the diff base — the inverse of GET /changes
  // (fork point for worktree workers, else HEAD). Destructive (reverts the user's
  // working tree), so UI-token gated like /conflicts/resolve: an agent holding
  // EOS_DAEMON_URL must not get a policy-free write path. The use-case re-derives
  // status from the same base the panel shows, so a stale path is a clean no-op.
  r.post(/^\/workers\/(?<id>[^/]+)\/changes\/discard$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(WorkerChangesDiscardRequestSchema, await readBody(req));
    if (!repoRelative(body.path)) { writeJson(res, 400, { error: "path must be repo-relative" }); return; }
    const w = c.workers.findById(params.id);
    const dir = readableGitDirOf(w);
    if (!dir) { writeJson(res, 404, { error: "worker has no working directory" }); return; }
    const result = await discardFileChange(
      { git: c.git, restore: c.workingTreeRestore },
      { cwd: dir, path: body.path, base: await diffBaseOf(c, w) },
    );
    if (result.ok) c.bus.publish("worker:change", { workerId: params.id });
    writeJson(res, result.ok ? 200 : 409, result);
  });
}
