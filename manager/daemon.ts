#!/usr/bin/env node
// Daemon entrypoint — composition root only.
//
// Responsibility split since the redesign:
//   * Adapters (sqlite, child_process, fs, http, pty) live in /infra
//   * Pure domain + use-cases live in /core
//   * Routes (one file per resource) live in ./routes
//   * Composition + wiring lives in ./container.ts
//
// This file just boots the container, mounts routes onto a Router, attaches
// the Router to an HTTP server, and handles process-level signals.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { buildContainer } from "./container.ts";
import { computeBackendStamp } from "./builder/backend-stamp.ts";
import { Router } from "./routes/Router.ts";
import { mintRequestId } from "./middleware/requestId.ts";
import { handleError, writeJson } from "./middleware/errorHandler.ts";
import { isLoopbackRequest } from "./middleware/loopback-lock.ts";
import { RemoteController } from "./remote/controller.ts";
import { registerRemoteRoutes } from "./routes/remote.ts";
import { dispatchMessage } from "../core/src/use-cases/DispatchMessage.ts";
import { drainQueuedMessages } from "../core/src/use-cases/DrainQueuedMessages.ts";
import { dispatchDeps } from "./routes/dispatch-deps.ts";
import { isWorkerLive } from "./routes/worker-liveness.ts";
import { resumeIfDead } from "./routes/resume-helpers.ts";
import { workerReportEnvelope } from "./shared/worker-report.ts";
import { classifyReport, stepStatusOfSignal } from "../core/src/domain/report-signal.ts";
import { worktreeStateHash } from "./shared/worktree-state-hash.ts";
import { createMemoCommandRunner } from "../infra/src/goalcheck/MemoCommandRunner.ts";
import { appendSynthesized } from "./shared/synthesized-events.ts";
import { GoalLoopService } from "./services/GoalLoopService.ts";
import { ReportGapService } from "./services/ReportGapService.ts";
import { ContextThresholdService } from "./services/ContextThresholdService.ts";
import { suspendWorker } from "./commands/handlers/suspend-worker.ts";
import { makePermissionAskPush } from "./services/permission-ask-push.ts";
import { reArmLoops, stopLoopForExitedWorker } from "./services/loop-rearm.ts";
import { reArmWorkflows } from "./services/workflow-rearm.ts";

import { registerHealthRoutes } from "./routes/health.ts";
import { registerStreamRoutes } from "./routes/stream.ts";
import { registerWorkerRoutes } from "./routes/workers.ts";
import { registerPtyRoutes } from "./routes/pty.ts";
import { registerOrchestratorRoutes } from "./routes/orchestrators.ts";
import { registerLoopRoutes } from "./routes/loops.ts";
import { registerWorkflowRoutes } from "./routes/workflows.ts";
import { registerPolicyRoutes } from "./routes/policy.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerFsPickerRoutes } from "./routes/fs-picker.ts";
import { registerFsReadRoutes } from "./routes/fs-read.ts";
import { registerSymbolRoutes } from "./routes/symbols.ts";
import { registerFsMutateRoutes } from "./routes/fs-mutate.ts";
import { registerFsGitRoutes } from "./routes/fs-git.ts";
import { registerCommandRoutes } from "./routes/commands.ts";
import { registerTemplateRoutes } from "./routes/templates.ts";
import { registerMemoryRoutes } from "./routes/memory.ts";
import { registerPromptRoutes } from "./routes/prompts.ts";
import { registerWorkerDefinitionRoutes } from "./routes/worker-definitions.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerUpdateRoutes } from "./routes/updates.ts";
import { registerMetricsRoutes } from "./routes/metrics.ts";
import { registerExportRoutes } from "./routes/export.ts";
import { registerDatetimeRoutes } from "./routes/datetime.ts";
import { registerScheduledPromptRoutes } from "./routes/scheduled-prompts.ts";
import { registerUiConfigRoutes } from "./routes/uiConfig.ts";
import { registerBackendsRoutes } from "./routes/backends.ts";
import { registerFsRawRoutes } from "./routes/fs-raw.ts";
import { registerCommandCatalog } from "./commands/register.ts";
import { fdStats } from "../infra/src/util/fd-stats.ts";

const c = buildContainer();

// Self-stamp once at boot: /health reports the source hash this process
// actually loaded. Never recompute per request — after a source edit an old
// daemon would report the NEW hash and read as falsely fresh.
const sourceStamp = computeBackendStamp(
  c.config.paths.repoRoot,
  join(c.config.daemon.home, "config.json"),
);

const router = new Router();
registerHealthRoutes(router, { pid: process.pid, startedAt: Date.now(), sourceStamp });
registerStreamRoutes(router, c);
// FS + UI routes registered before /workers etc. Order matters: first match
// wins.
registerUiConfigRoutes(router, c);
registerBackendsRoutes(router, c);
registerMetricsRoutes(router, c);
registerDatetimeRoutes(router, c);
registerScheduledPromptRoutes(router, c);
registerFsPickerRoutes(router, c);
registerFsReadRoutes(router, c);
registerSymbolRoutes(router, c);
registerFsMutateRoutes(router, c);
registerFsGitRoutes(router, c);
registerCommandRoutes(router, c);
registerTemplateRoutes(router, c);
registerMemoryRoutes(router, c);
registerPromptRoutes(router, c);
registerWorkerDefinitionRoutes(router, c);
registerSettingsRoutes(router, c);
registerUpdateRoutes(router, c);
// Unified command catalog (worker.spawn, worker.kill, …) — registered before
// the hand-written worker routes so a migrated path resolves here first.
registerCommandCatalog(router, c);
// Workflow-orchestration: run-control + read surface.
registerWorkflowRoutes(router, c);
registerWorkerRoutes(router, c);
registerPtyRoutes(router, c);
registerExportRoutes(router, c);
registerOrchestratorRoutes(router, c);
registerLoopRoutes(router, c);
registerPolicyRoutes(router, c);
registerPendingRoutes(router, c);
// Remote pairing-arm + live arm/disarm control routes (loopback + ui-token). The
// controller is created after the server binds, so the routes reach it lazily via
// a holder. arm() reloads config from disk first so the rebuild sees the Save.
let remoteController: RemoteController | null = null;
registerRemoteRoutes(router, {
  uiToken: c.uiToken,
  getConfig: () => c.config,
  getGateway: () => remoteController?.current() ?? null,
  arm: () => { c.reloadConfig(); return remoteController?.reconcile() ?? { mode: "off", armed: false }; },
});

// Queue drain — queued dashboard messages dispatch when their worker reaches
// IDLE. Triggers: every IDLE state transition (payload carries `state`), plus
// the enqueue signal (`queued`) that closes the enqueue/turn-end race. The
// in-flight set keeps bus bursts from double-draining; the use-case re-checks
// state + pending rows itself, so a spurious trigger is a no-op.
// Dynamic-loop goal gate. Re-triggers a looped worker whose goal isn't yet met.
// Fired ONLY from the queue-drain "empty" branch below, so peer > queue > loop
// holds: a queued child report always drains before a self-continue. Dispatches
// with queueWhenBusy so a peer that arrives during the async goal-check queues
// the continuation instead of steering mid-turn.
const goalLoop = new GoalLoopService({
  workers: c.workers,
  loops: c.loops,
  messageQueue: c.messageQueue,
  peerRequests: c.pendingPeerRequests,
  strategyFor: c.strategyFor,
  // origin:"loop" carries a loop envelope so the continuation is wrapped as a
  // <system_message kind="dynamic_loop" attempt=…> (not an operator turn) and is
  // agent-plane (no pill). displayText = the bare continuation body the chat
  // renders (the wrapper never reaches the UI); attempt rides the tag.
  dispatch: (input) => dispatchMessage(dispatchDeps(c), {
    workerId: input.workerId,
    text: input.text,
    origin: input.origin,
    queueWhenBusy: true,
    ...(input.origin === "loop"
      ? { envelope: { kind: "loop" as const, ...(input.attempt != null ? { attempt: input.attempt } : {}) }, displayText: input.text }
      : {}),
  }),
  // Release a held report to the parent as a worker_report — resume a
  // suspended parent first (a report held for minutes can outlive its parent's
  // session), build the same wrapper the report route uses, and queue it (fan-in
  // serialized) exactly like a direct report.
  releaseReport: async ({ workerId, parentId, text, provenance }) => {
    // Read the structured held output BEFORE resumeIfDead may settle the loop —
    // the loop is still active here (runLoopTick clears it only after this returns).
    const heldOutput = c.loops.findActiveByWorker(workerId)?.heldOutput ?? null;
    const parent = c.workers.findById(parentId);
    if (parent) await resumeIfDead(c, parent);
    const w = c.workers.findById(workerId);
    // Bridge the loop release to a waiting workflow step-join (§3.4 / D3): the
    // /step-output route held the first output (workflow:step-output{held:true}) so
    // the join waited; emit the terminal {held:false} so WorkerSpawnAdapter.onStepOutput
    // resolves it. Republish the STRUCTURED held output VERBATIM — the typed object
    // + its self-declared status — so a released looped step delivers its object
    // (not a stringified body) and a failed step STAYS failed (no classifyReport
    // status inversion, H2). A non-workflow loop has no held output → fall back to
    // the text signal (harmless: the adapter is the sole subscriber, no step-join).
    c.bus.publish("workflow:step-output", heldOutput
      ? { workerId, parentId, output: heldOutput.output, status: heldOutput.status, reason: heldOutput.reason, held: false }
      : { workerId, parentId, output: text, status: stepStatusOfSignal(classifyReport(text)), held: false });
    return dispatchMessage(dispatchDeps(c), {
      workerId: parentId,
      // Clean body; the <agent_message|system_message …> wrapper (with the
      // branch/worktree merge handle) is applied at the dispatch chokepoint from
      // the envelope. provenance = "agent" for a held report, "system" for a
      // daemon-synthesized loop-complete/exhausted message.
      text,
      displayText: text,
      envelope: w
        ? workerReportEnvelope(w, provenance)
        : { kind: "worker_report", provenance, fromWorker: workerId, workerName: workerId },
      queueWhenBusy: true,
      origin: "report",
    });
  },
  stateHash: (input) => worktreeStateHash(c.git, input),
  // One memoizing runner per check so a hybrid tick runs each verify command once
  // (the deterministic pass and the evidence collector share it).
  makeCommandRunner: () => createMemoCommandRunner(),
  noProgressWindow: c.config.loop.noProgressWindow,
  stopOnNoProgress: c.config.loop.stopOnNoProgress,
  publishChange: (workerId, status) => c.bus.publish("loop:change", { workerId, status }),
  // Transient: any "loop:check" payload auto-forwards to the UI via SSE's "*"
  // subscription. Durable: one "loop_check" timeline row per attempt outcome.
  publishCheck: (progress) => c.bus.publish("loop:check", progress),
  recordCheck: (workerId, event) => appendSynthesized(c, workerId, "loop_check", event),
  renderer: c.prompts,
  isLive: (id) => isWorkerLive(c, id),
  clock: c.clock,
  log: c.log,
});

// Report-gap safety net. Owns its worker:report (mark reported) + worker:exit
// (reclaim) subscriptions via start(); the daemon only wires checkOnIdle into
// the drain "empty" branch below (sibling of goalLoop.loopTickFor). A worker
// that reaches IDLE having never reported this life gets ONE report reminder.
const reportGap = new ReportGapService({
  workers: c.workers,
  loops: c.loops,
  isLive: (id) => isWorkerLive(c, id),
  dispatch: (input) => dispatchMessage(dispatchDeps(c), input),
  renderer: c.prompts,
  bus: c.bus,
  log: c.log,
});
reportGap.start();

// Context-budget watcher (R3/R4). Sibling of reportGap: rides the same IDLE edge
// and, when a worker crosses ~90%/~95% of its model context window, notifies the
// worker's parent (system_message) and — at full — auto-suspends the worker with
// its worktree preserved. Exactly-once per crossing via the persistent latch.
const contextThreshold = new ContextThresholdService({
  workers: c.workers,
  marks: c.contextMarks,
  contextWindowFor: (model) => c.modelCatalog.contextWindowFor(model),
  dispatch: (input) => dispatchMessage(dispatchDeps(c), input),
  suspend: (id, reason) => suspendWorker(c, id, reason),
  warnRatio: c.config.context.warnRatio,
  fullRatio: c.config.context.fullRatio,
  log: c.log,
});

const draining = new Set<string>();
const drainFor = (workerId: string): void => {
  if (draining.has(workerId)) return;
  draining.add(workerId);
  void (async () => {
    try {
      return await drainQueuedMessages(
        {
          workers: c.workers, queue: c.messageQueue, clock: c.clock, log: c.log,
          clearTurnSettle: (id) => c.turnSettle.clear(id),
          dispatch: (input) => dispatchMessage(dispatchDeps(c), input),
        },
        { workerId },
      );
    } catch (e) {
      c.log.warn("queue drain error", { workerId, error: e instanceof Error ? e.message : String(e) });
      return "failed" as const;
    } finally {
      draining.delete(workerId);
    }
  })().then((outcome) => {
    // A row enqueued while this pass was in flight had its queued:true
    // trigger swallowed by the in-flight guard — re-run once for it. Only
    // "empty" re-runs: "dispatched" lifted the worker to WORKING (its Stop
    // triggers the next drain), "not-idle" waits for the next IDLE
    // transition, and "failed" retrying here would hot-loop on a dead port.
    if (outcome === "empty" && c.messageQueue.listPending(workerId).length > 0) {
      drainFor(workerId);
      return;
    }
    // Queue genuinely empty at IDLE → it's the loop's turn (no-op when the
    // worker has no active loop). "dispatched"/"not-idle"/"failed" never reach
    // here, so a drained message or a busy worker is never preempted.
    if (outcome === "empty") {
      goalLoop.loopTickFor(workerId);
      // Sibling of the loop tick: nudge a worker that went idle having never
      // reported this life. Self-excludes looped and already-reported workers,
      // so at most one of these two fires.
      reportGap.checkOnIdle(workerId);
      // Sibling of the report-gap nudge: warn the parent at ~90% context and
      // auto-suspend the worker at ~95% (worktree preserved). Latched exactly-once.
      contextThreshold.checkOnIdle(workerId);
    }
  });
};
// Peer-request pump — a collaborate worker's queued consultations are delivered
// into the target peer's PTY when it next reaches IDLE, one at a time. A
// delivered-but-unanswered request is auto-declined when the peer ends that
// turn, so the asker (blocked in ask_peer) always unblocks within one turn.
// Mirrors the queue drain: an in-flight guard plus an explicit WORKING
// transition stop a stale IDLE event from re-delivering or wrongly declining
// the just-delivered request.
const peerPumping = new Set<string>();
const pumpPeerFor = (workerId: string): boolean => {
  if (peerPumping.has(workerId)) return true;
  const w = c.workers.findById(workerId);
  if (!w || w.state !== "IDLE") return false;
  // Still-delivered at IDLE = the peer ended its turn without responding.
  c.pendingPeerRequests.declineDelivered(workerId, "peer ended its turn without responding");
  const next = c.pendingPeerRequests.nextQueuedFor(workerId);
  if (!next) return false;
  if (!isWorkerLive(c, workerId)) return false;
  peerPumping.add(workerId);
  c.pendingPeerRequests.markDelivered(next.requestId);
  const asker = c.workers.findById(next.from);
  const fromName = asker?.name ?? next.from;
  // The sender identity is carried by the <agent_message from=…> wrapper (applied
  // at the dispatch chokepoint from the peer_request envelope); the body keeps only
  // the question + the genuinely instructional guidance the tag can't convey.
  const body =
    `${next.question}\n\n` +
    `Answer this from your area, then call respond_to_peer with your answer — that is the only thing that reaches ${fromName}; plain text in this turn does not.`;
  // Backend-aware delivery + settle-clear + WORKING lift, same path as the
  // dashboard and report flows — a port-less in-process (claude-sdk) peer is
  // reachable too (the old httpWorkerClient.sendMessage(w.port,…) silently
  // skipped them). PTY peer self-reports peer_request at its transcript
  // sighting; in-process gets the daemon-side append. displayText = the bare
  // question the chat renders (without the wrapper or the guidance).
  void dispatchMessage(dispatchDeps(c), {
    workerId, text: body, displayText: next.question,
    envelope: { kind: "peer_request", fromWorker: next.from, fromName: asker?.name ?? undefined },
    origin: "peer-request",
  })
    .catch((e) => {
      c.pendingPeerRequests.declineDelivered(workerId, "delivery to peer failed");
      c.log.warn("peer request delivery failed", { workerId, error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => peerPumping.delete(workerId));
  return true;
};

c.bus.subscribe("worker:change", (msg) => {
  const p = msg.payload as { workerId?: string; state?: string; queued?: boolean };
  if (!p?.workerId) return;
  // pumpPeerFor reads the worker's real state itself (self-guards on IDLE), so
  // it fires on a real IDLE transition AND on the route's plain nudge after a
  // peer-request registers. A delivery starts a turn (→ WORKING); let the
  // dashboard queue drain wait for the next IDLE so they never share a turn.
  if (pumpPeerFor(p.workerId)) return;
  if (p.state !== "IDLE" && p.queued !== true) return;
  drainFor(p.workerId);
});

// Order-independent peer discovery — a newly-spawned collaborate worker may be
// the provider an earlier consumer already asked for (ask_peer registered before
// the provider's row existed → parked as "awaiting"). Re-resolve the awaiting
// consults in its group: a matching one binds (→ queued) and the pump delivers
// it at the provider's next IDLE; nudge any bound target that is already IDLE so
// it pumps now. tryBind is idempotent and group-scoped, so this is cheap.
c.bus.subscribe("worker:spawn", (msg) => {
  const p = msg.payload as { workerId?: string };
  if (!p?.workerId) return;
  const w = c.workers.findById(p.workerId);
  if (!w?.collaborate || !w.parent_id) return;
  for (const targetId of c.pendingPeerRequests.tryBind(w.parent_id, c.workers)) {
    c.bus.publish("worker:change", { workerId: targetId });
  }
});

// Dynamic-loop arm — closes the dormant-loop race: a loop attached AFTER the
// worker already reached IDLE missed the goal-gate's IDLE edge, and nothing else
// would ever tick it. The attach route publishes loop:change{active} AFTER
// persisting the row; the in-process bus is synchronous, so this subscriber sees
// the persisted loop. loopTickFor is idempotent (ticking Set + IDLE guard), so a
// continued-republish or a concurrent IDLE drain safely no-ops.
c.bus.subscribe("loop:change", (msg) => {
  const p = msg.payload as { workerId?: string; status?: string };
  if (p?.workerId && p.status === "active") goalLoop.loopTickFor(p.workerId);
});

// Permission-ask push — a child worker parking on a policy `ask` rule publishes
// "pending:created"; nudge its DIRECT parent (the session that can act on the ask)
// so a pending decision doesn't sit unnoticed. Same injector shape as the
// dynamic-loop / report-reminder pushes: dispatch through the shared chokepoint,
// queued if the parent is mid-turn, idempotent per pending id.
const permissionAskPush = makePermissionAskPush({
  findWorker: (id) => c.workers.findById(id),
  findPending: (id) => c.pending.findById(id),
  dispatch: (input) => dispatchMessage(dispatchDeps(c), input),
  log: c.log,
});
c.bus.subscribe("pending:created", (msg) =>
  permissionAskPush(msg.payload as { id?: string; workerId?: string }),
);

// Micro-task subsystem — subscribes its triggers (auto-name fires on an
// orchestrator's first WORKING transition). Mirrors the goal-loop bus wiring.
c.microTasks.start();

// Peer death-detection — when a worker exits for ANY reason (crash, normal
// close, kill), unblock every peer waiting on it: its inbound requests go
// "gone" so the asker's ask_peer returns a clear "peer unavailable" instead of
// hanging forever, and its outbound requests are dropped. onExit publishes this
// for all exit paths; the kill/interrupt/clear routes also cancel eagerly, this
// is the backstop for an unexpected crash/exit (the case the asker can't see).
c.bus.subscribe("worker:exit", (msg) => {
  const p = msg.payload as { workerId?: string };
  if (!p?.workerId) return;
  c.pendingPeerRequests.cancelByWorker(p.workerId);
  // Reclaim the rest of this worker's in-memory service state. The DELETE route
  // does the same, but natural/crash exits (SIGHUP=129, mid-turn crash) never
  // pass through DELETE, so their entries would otherwise leak until restart.
  // All idempotent; turnSettle.clear is safe — a dead worker has no turn to starve.
  c.pendingQuestions.cancelByWorker(p.workerId);
  c.backgroundActivity.clearWorker(p.workerId);
  c.turnSettle.clear(p.workerId);
  c.events.forgetPruneCounter(p.workerId);
  // A worker that exits/dies leaves its active loop orphaned — stop it.
  stopLoopForExitedWorker({ loops: c.loops, bus: c.bus }, p.workerId);
});

// Git watch set — keep the GitWatcher's watched dirs in sync with the live
// worker rows. The reconciler debounces, so the worker:change firehose during a
// turn is cheap; worker:change is what re-attaches a fresh worktree once its
// workspace_ready flips (its precomputed dir wasn't a repo at spawn time).
for (const topic of ["worker:spawn", "worker:change", "worker:exit", "worker:removed"] as const) {
  c.bus.subscribe(topic, () => c.gitWatchReconciler.schedule());
}

function makeHandler(router: Router, opts: { cors?: boolean } = {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    c.metrics.requests++;
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    // The bundled app UI loads from the eos:// custom-scheme origin, so its
    // fetch/EventSource calls to this loopback API are cross-origin. Reflect
    // the Origin (loopback-only server, mutations still gated by
    // x-eos-ui-token) and answer preflight. Never applied to the raw server —
    // its untrusted content must stay origin-isolated.
    if (opts.cors) {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
      }
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
      // x-filename: the /fs/paste upload (image paste) sends it; without it the
      // cross-origin preflight from eos://app/ blocks the POST and paste fails.
      res.setHeader("access-control-allow-headers", "content-type, x-eos-ui-token, x-filename");
      // content-disposition: the export download reads the server-chosen filename
      // (orchestrator name + date) off this header; unexposed it's invisible to
      // cross-origin fetch and the UI falls back to the raw worker id.
      res.setHeader("access-control-expose-headers", "content-disposition");
      res.setHeader("access-control-max-age", "86400");
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // Loopback-lock (design §2.2/§4.7). A request reaching this handler is a
    // plain REST/SSE/raw call — the authenticated /ws upgrade is handled on the
    // server "upgrade" event and never arrives here. Anything from a non-loopback
    // peer means the bind was widened; reject it so the only off-box surface is
    // the E2E-terminating WS. No-op while bound to loopback (today's default).
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "remote REST access is disabled; the only remote surface is the /ws gateway" });
      return;
    }

    const requestId = mintRequestId(req, res, c.ids);

    try {
      const match = router.match(method, url.pathname);
      if (!match) {
        writeJson(res, 404, { error: "not found", path: url.pathname });
        return;
      }
      await match.handler({
        method,
        path: url.pathname,
        url,
        params: match.params,
        req,
        res,
        requestId,
      });
    } catch (e) {
      handleError(res, e, {
        requestId,
        method,
        path: url.pathname,
        log: c.log,
        metrics: c.metrics,
      });
    }
  };
}

const server = createServer(makeHandler(router, { cors: true }));

// Remote edge (iOS). The controller installs ONE persistent /ws upgrade listener
// and arms the gateway live: the initial reconcile() arms ONLY when
// config.remote.mode != off (default off ⇒ no surface, /ws 503s). Enabling later
// via POST /api/remote/arm is restart-free — no reboot needed. Off-box
// reachability stays bounded to the authenticated /ws upgrade by the loopback-lock
// middleware above.
remoteController = new RemoteController(c, router, server);
remoteController.reconcile();

// Raw-content origin: arbitrary disk bytes + the vendored pdf.js viewer on a
// separate port. Viewer iframes run untrusted HTML with `allow-same-origin`,
// so that content must never share an origin with the uiToken-bearing app/API
// server above.
const rawRouter = new Router();
registerFsRawRoutes(rawRouter, c);
const rawServer = createServer(makeHandler(rawRouter));

server.listen(c.config.daemon.port, c.config.daemon.host, () => {
  c.log.info("listening", {
    url: `http://${c.config.daemon.host}:${c.config.daemon.port}`,
    state: c.config.daemon.dbFile,
    logs: c.config.daemon.logDir,
  });
});
rawServer.listen(c.config.daemon.rawPort, c.config.daemon.host, () => {
  c.log.info("raw listening", {
    url: `http://${c.config.daemon.host}:${c.config.daemon.rawPort}`,
  });
});

// Boot re-arm — revive each active loop after a restart. Fire-and-forget, after
// both listeners are up (a resumed out-of-process worker POSTs events back) and
// the bus subscriptions are registered (the gate is armed for later iterations).
// Boot reconcile already ran synchronously inside buildContainer.
void reArmLoops({
  loops: c.loops,
  workers: c.workers,
  resume: (worker) => resumeIfDead(c, worker),
  loopTickFor: (id) => goalLoop.loopTickFor(id),
  log: c.log,
});

// Boot re-arm — re-drive each non-terminal workflow run after a restart
// (sibling of reArmLoops). ReconcileWorkersOnBoot already reconciled every
// step-worker row (SUSPENDED/DONE) inside buildContainer; engine.resume replays
// journaled steps from their memoized output and runs the first un-journaled node
// live. Voided so a long-running run never blocks boot.
void reArmWorkflows({
  runs: c.workflowRuns,
  steps: c.workflowSteps,
  events: c.events,
  queue: c.messageQueue,
  resume: (runId) => c.workflowService.resume(runId),
  log: c.log,
});

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const ids = c.supervisor.listIds();
  c.log.info("shutting down", { signal: sig, workers: ids.length });
  try { remoteController?.disarm(); } catch {}
  for (const id of ids) c.supervisor.escalateKill(id, 0);
  try { unlinkSync(c.config.daemon.pidFile); } catch {}
  try { c.db.close(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
// fd pressure early-warning. The daemon climbs toward RLIMIT_NOFILE silently
// (pipes per worker + a kqueue fd per watched dir + sockets); past the ceiling,
// new worker spawns fail with EBADF/EMFILE. Surface it at 80% so it is visible
// before it bites. Unref'd: never keeps the process alive on its own.
const fdWarnTimer = setInterval(() => {
  const { open, limit } = fdStats();
  if (open != null && limit != null && limit > 0 && open / limit > 0.8) {
    c.log.warn("fd pressure", { open, limit, pct: Math.round((open / limit) * 100) });
  }
}, 30_000);
fdWarnTimer.unref?.();

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Surface but don't crash on async bugs — a SQLite throw inside an exit
// handler or a buggy interval callback used to kill the whole daemon and
// orphan every spawned worker. Logging + continuing is the right default
// for a single-host orchestrator that can recover from transient state.
process.on("uncaughtException", (e: Error) => {
  c.log.error("uncaughtException", { error: e.message, stack: e.stack });
});
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  c.log.error("unhandledRejection", { reason: msg });
});
