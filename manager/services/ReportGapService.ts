// ReportGapService — the safety net for a worker that ends a turn having NEVER
// reported this life. It watches the same IDLE edge the goal loop does and, when
// a worker goes idle without ever calling send_message_to_parent, injects ONE
// <system_message kind="report_reminder"> nudging it to report.
//
// State is two in-memory Sets, mirroring MicroTaskRunner.seen / GoalLoopService
// .ticking: `reported` (marked on the worker:report bus event — which fires at
// the single /report chokepoint BEFORE the hold/queue disposition, so held,
// queued, needs-input, and failed reports all count) and `reminded` (the
// once-per-life guard). Both are reclaimed on worker:exit, so a reaped-then-
// resumed worker owes a fresh report. Nothing is persisted — this is a safety
// net, and every per-worker runtime signal in this daemon is in-memory.
//
// checkOnIdle branches on agent_role/state/parent/loops — NEVER backend_kind.
// The positive `agent_role === "worker"` gate is the runtime mirror of the DPI
// obligation gate (role==worker ∧ isSubagent): it excludes orchestrators, git
// agents, and workflow-worker nodes (none of which carry the report obligation)
// in one check, and a future role is excluded by default.

import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type { LoopStateRepo } from "../../core/src/ports/LoopStateRepo.ts";
import type { PromptRenderer } from "../../core/src/ports/PromptRenderer.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

// The reminder template id — path-derived (manager/prompts/system/report-reminder
// .prompt.md), the same id scheme loop/continuation uses. Rendered directly by id
// (not a DPI-selected fragment); SEND_MESSAGE_TO_PARENT_TOOL resolves from the
// PromptService globals (TOOL_NAME_VARS).
const REPORT_REMINDER_TEMPLATE = "system/report-reminder";

export interface ReportGapDeps {
  workers: Pick<WorkerRepo, "findById">;
  loops: Pick<LoopStateRepo, "findActiveByWorker">;
  isLive(workerId: string): boolean;
  // Rides the same dispatch chokepoint as every other injection: the sender tag
  // wraps the body once as <system_message kind="report_reminder">, both lanes
  // (PTY self-report record + in-process daemon-side chat event) are handled there.
  dispatch(input: {
    workerId: string;
    text: string;
    displayText: string;
    envelope: { kind: "report_reminder" };
    queueWhenBusy: boolean;
    origin: string;
  }): Promise<unknown>;
  renderer: Pick<PromptRenderer, "render">;
  bus: EventBus;
  log: Logger;
}

function readWorkerId(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const id = (payload as { workerId?: unknown }).workerId;
    if (typeof id === "string") return id;
  }
  return null;
}

export class ReportGapService {
  private readonly deps: ReportGapDeps;
  // Has reported at least once this life (marked at the /report bus event).
  private readonly reported = new Set<string>();
  // Has already been nudged this life (the once-per-life guard).
  private readonly reminded = new Set<string>();
  private started = false;

  constructor(deps: ReportGapDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // worker:report fires for EVERY report (incl. a held looped report), so a
    // worker that reported in any form is disarmed.
    this.deps.bus.subscribe("worker:report", (msg) => this.onReport(msg.payload));
    // worker:exit reclaims both Sets — a resumed worker starts fresh.
    this.deps.bus.subscribe("worker:exit", (msg) => this.onExit(msg.payload));
  }

  // Fire the reminder IFF the worker is idle+live, carries the report obligation
  // (agent_role==="worker" ∧ has a parent), is not looping (a loop always emits a
  // terminal signal itself), and has neither reported nor been reminded this life.
  checkOnIdle(workerId: string): void {
    if (this.reminded.has(workerId)) return;
    if (this.reported.has(workerId)) return;
    const w = this.deps.workers.findById(workerId);
    if (!w || String(w.state).toUpperCase() !== "IDLE") return;
    if (!this.deps.isLive(workerId)) return;
    if (w.agent_role !== "worker") return;
    if (w.parent_id == null) return;
    if (this.deps.loops.findActiveByWorker(workerId) != null) return;

    // Mark BEFORE dispatch (mark-before-fire) — an IDLE-firehose re-entry, or the
    // reminded turn ending IDLE-and-still-unreported, is then a guaranteed no-op.
    this.reminded.add(workerId);
    void this.fire(workerId);
  }

  private onReport(payload: unknown): void {
    const id = readWorkerId(payload);
    if (id) this.reported.add(id);
  }

  private onExit(payload: unknown): void {
    const id = readWorkerId(payload);
    if (!id) return;
    this.reported.delete(id);
    this.reminded.delete(id);
  }

  private async fire(workerId: string): Promise<void> {
    try {
      const text = this.deps.renderer.render(REPORT_REMINDER_TEMPLATE).trim();
      await this.deps.dispatch({
        workerId,
        text,
        // The chat renders the bare body; the <system_message> wrapper the tag
        // applies never reaches the UI.
        displayText: text,
        envelope: { kind: "report_reminder" },
        // IDLE+empty at fire → direct; defensive if a race lifts the worker to WORKING.
        queueWhenBusy: true,
        origin: "report-reminder",
      });
    } catch (e) {
      this.deps.log.warn("report reminder dispatch failed", { workerId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
