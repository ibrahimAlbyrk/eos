import { readFileSync } from "node:fs";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { AgentEvent, SubagentUsage, WorkflowRunSnapshot } from "../../contracts/src/canonical.ts";
import type { PtyConversationRow } from "../../contracts/src/http.ts";
import type { WorkerEventRow } from "../../contracts/src/events.ts";
import {
  WORKFLOW_AGENT_ID_RE, WORKFLOW_AGENT_ROWS_MAX, WORKFLOW_RUN_TOPICS,
  type WorkflowRunDetail, type WorkflowRunProgress,
} from "../../contracts/src/workflow-run.ts";
import {
  EMPTY_WORKFLOW_SNAPSHOT, parseWorkflowRecord, settleWorkflowSnapshot, withWorkflowRecord, workflowAgentTranscriptPath, workflowRecordPath,
} from "../../core/src/domain/workflow-run.ts";
import { TranscriptFile } from "./pty/transcriptFile.ts";

// Claude Code Workflow runs, live and finished. A running run's progress is
// held here (latest snapshot only) and relayed as workflow:progress at most
// every throttleMs; it is never written to the event log, whose per-worker cap
// would otherwise lose transcript rows to progress ticks. The durable record is
// the workflow_started / workflow_completed agent events, plus the files Claude
// Code itself keeps for the run (its record and each agent's transcript).

type Started = Extract<AgentEvent, { type: "workflow_started" }>;
type Completed = Extract<AgentEvent, { type: "workflow_completed" }>;

interface StopCapable {
  isAlive(): boolean;
  stopTask?(taskId: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface WorkflowRunServiceDeps {
  bus: Pick<EventBus, "publish">;
  // The worker's agent_event rows, id-ASC.
  agentEvents(workerId: string): WorkerEventRow[];
  session(workerId: string): StopCapable | null;
  // Claude Code's projects dir (~/.claude/projects): the only place run files are read from.
  claudeProjectsDir: string;
  // A run's record.
  readFile?(path: string): string | null;
  now?(): number;
  throttleMs?: number;
}

interface LiveRun {
  workerId: string;
  callId: string;
  taskId: string;
  started?: Started;
  startedAt?: number;
  snapshot: WorkflowRunSnapshot;
  usage?: SubagentUsage;
  updatedAt: number;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export type StopResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

// Agent transcripts kept parsed, so a drawer refetching a working agent reads
// only what the agent appended since.
const AGENT_TRANSCRIPTS_KEPT = 4;

const readOrNull = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

export class WorkflowRunService {
  private live = new Map<string, LiveRun>();
  private agentTranscripts = new Map<string, TranscriptFile>(); // by path, least recently read first
  private deps: WorkflowRunServiceDeps;
  private readFile: (path: string) => string | null;
  private now: () => number;
  private throttleMs: number;

  constructor(deps: WorkflowRunServiceDeps) {
    this.deps = deps;
    this.readFile = deps.readFile ?? readOrNull;
    this.now = deps.now ?? Date.now;
    this.throttleMs = deps.throttleMs ?? 500;
  }

  // The backend's latest snapshot of a running run.
  onProgress(p: WorkflowRunProgress): void {
    const run = this.entry(p.workerId, p.callId, p.taskId);
    run.snapshot = p.snapshot;
    if (p.usage) run.usage = p.usage;
    run.updatedAt = p.updatedAt;
    const wait = run.sentAt + this.throttleMs - this.now();
    if (wait <= 0) this.send(run);
    else if (!run.timer) run.timer = setTimeout(() => this.send(run), wait);
  }

  // Every agent event of a worker passes here; only a run's start and end matter.
  observe(workerId: string, event: AgentEvent): void {
    if (event.type === "workflow_started") {
      const run = this.entry(workerId, event.callId, event.taskId);
      run.started = event;
      run.startedAt = this.now();
    } else if (event.type === "workflow_completed") {
      const key = keyOf(workerId, event.callId);
      const run = this.live.get(key);
      if (run?.timer) clearTimeout(run.timer);
      this.live.delete(key);
      // The end goes out at once: an open side-panel tab learns it here, not
      // from the transcript it may not have loaded.
      const usage = event.usage ?? run?.usage;
      this.deps.bus.publish(WORKFLOW_RUN_TOPICS.progress, {
        workerId, callId: event.callId, taskId: event.taskId, status: event.status,
        snapshot: settleWorkflowSnapshot(event.snapshot ?? run?.snapshot ?? EMPTY_WORKFLOW_SNAPSHOT, event.status),
        ...(usage ? { usage } : {}), updatedAt: this.now(),
      } satisfies WorkflowRunProgress);
    }
  }

  // A worker's running runs.
  list(workerId: string): WorkflowRunDetail[] {
    return [...this.live.values()].filter((r) => r.workerId === workerId).map((r) => this.detailOfLive(r));
  }

  get(workerId: string, callId: string): WorkflowRunDetail | null {
    const run = this.live.get(keyOf(workerId, callId));
    if (run) return this.detailOfLive(run);
    const { started, completed } = this.recorded(workerId, callId);
    if (!started && !completed) return null;
    const s = started?.event;
    const c = completed?.event;
    const usage = c?.usage;
    // Started, never ended, not live: the session that ran it is gone.
    const status = c?.status ?? "stopped";
    return {
      callId,
      taskId: s?.taskId ?? c!.taskId,
      ...(s?.runId ? { runId: s.runId } : {}),
      ...(s?.name ? { name: s.name } : {}),
      ...(s?.description ? { description: s.description } : {}),
      status,
      ...(started ? { startedAt: started.ts } : {}),
      ...(completed ? { endedAt: completed.ts } : {}),
      ...(c?.summary ? { summary: c.summary } : {}),
      ...(usage ? { usage } : {}),
      // Settled after the record: Claude Code's record keeps a stopped run's agents in progress too.
      snapshot: settleWorkflowSnapshot(this.withRecord(c?.snapshot ?? EMPTY_WORKFLOW_SNAPSHOT, s?.transcriptDir), status),
      canStop: false,
    };
  }

  // One agent's transcript, as worker-event rows.
  agentRows(workerId: string, callId: string, agentId: string): PtyConversationRow[] | null {
    if (!WORKFLOW_AGENT_ID_RE.test(agentId)) return null;
    const dir = this.live.get(keyOf(workerId, callId))?.started?.transcriptDir
      ?? this.recorded(workerId, callId).started?.event.transcriptDir;
    const path = dir && this.isRunDir(dir) ? workflowAgentTranscriptPath(dir, agentId) : null;
    const view = path ? this.agentTranscript(path).read() : null;
    return view ? view.rows.slice(-WORKFLOW_AGENT_ROWS_MAX) : null;
  }

  async stop(workerId: string, callId: string): Promise<StopResult> {
    const run = this.live.get(keyOf(workerId, callId));
    if (!run) return { ok: false, status: 404, error: "no running workflow with that call id" };
    const session = this.deps.session(workerId);
    if (!session?.stopTask || !session.isAlive()) return { ok: false, status: 409, error: "this session can't stop a workflow" };
    const r = await session.stopTask(run.taskId);
    return r.ok ? { ok: true } : { ok: false, status: 409, error: r.reason ?? "stop failed" };
  }

  dispose(): void {
    for (const run of this.live.values()) if (run.timer) clearTimeout(run.timer);
    this.live.clear();
    this.agentTranscripts.clear();
  }

  private agentTranscript(path: string): TranscriptFile {
    const t = this.agentTranscripts.get(path) ?? new TranscriptFile(path, { sidechain: true });
    this.agentTranscripts.delete(path);
    this.agentTranscripts.set(path, t);
    if (this.agentTranscripts.size > AGENT_TRANSCRIPTS_KEPT) this.agentTranscripts.delete(this.agentTranscripts.keys().next().value!);
    return t;
  }

  private entry(workerId: string, callId: string, taskId: string): LiveRun {
    const key = keyOf(workerId, callId);
    let run = this.live.get(key);
    if (!run) {
      run = { workerId, callId, taskId, snapshot: EMPTY_WORKFLOW_SNAPSHOT, updatedAt: this.now(), sentAt: -Infinity, timer: null };
      this.live.set(key, run);
    }
    return run;
  }

  private send(run: LiveRun): void {
    run.timer = null;
    run.sentAt = this.now();
    // A run that ended while this send waited is no longer here to relay.
    if (this.live.get(keyOf(run.workerId, run.callId)) !== run) return;
    const payload: WorkflowRunProgress = {
      workerId: run.workerId, callId: run.callId, taskId: run.taskId, status: "running", snapshot: run.snapshot,
      ...(run.usage ? { usage: run.usage } : {}), updatedAt: run.updatedAt,
    };
    this.deps.bus.publish(WORKFLOW_RUN_TOPICS.progress, payload);
  }

  private detailOfLive(run: LiveRun): WorkflowRunDetail {
    const s = run.started;
    const session = this.deps.session(run.workerId);
    return {
      callId: run.callId,
      taskId: run.taskId,
      ...(s?.runId ? { runId: s.runId } : {}),
      ...(s?.name ? { name: s.name } : {}),
      ...(s?.description ? { description: s.description } : {}),
      status: "running",
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.usage ? { usage: run.usage } : {}),
      snapshot: this.withRecord(run.snapshot, s?.transcriptDir),
      canStop: session?.stopTask !== undefined && session.isAlive(),
    };
  }

  // Phase details and logs live only in the run's record, once Claude Code wrote it.
  private withRecord(snapshot: WorkflowRunSnapshot, dir: string | undefined): WorkflowRunSnapshot {
    const path = dir && this.isRunDir(dir) ? workflowRecordPath(dir) : null;
    const json = path ? this.readFile(path) : null;
    const record = json ? parseWorkflowRecord(json) : null;
    return record ? withWorkflowRecord(snapshot, record) : snapshot;
  }

  private isRunDir(dir: string): boolean {
    const root = this.deps.claudeProjectsDir.replace(/\/+$/, "");
    return dir.startsWith(`${root}/`) && workflowRecordPath(dir) !== null;
  }

  private recorded(workerId: string, callId: string): { started?: { event: Started; ts: number }; completed?: { event: Completed; ts: number } } {
    const out: { started?: { event: Started; ts: number }; completed?: { event: Completed; ts: number } } = {};
    for (const row of this.deps.agentEvents(workerId)) {
      if (!row.payload || !row.payload.includes('"workflow_') || !row.payload.includes(callId)) continue;
      let e: AgentEvent;
      try { e = JSON.parse(row.payload) as AgentEvent; } catch { continue; }
      if (e.type === "workflow_started" && e.callId === callId) out.started = { event: e, ts: row.ts };
      else if (e.type === "workflow_completed" && e.callId === callId) out.completed = { event: e, ts: row.ts };
    }
    return out;
  }
}

const keyOf = (workerId: string, callId: string): string => `${workerId}\u0000${callId}`;
