import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { AgentEvent } from "../../contracts/src/canonical.ts";
import {
  BACKGROUND_JOB_OUTPUT_MAX, BACKGROUND_JOB_TOPICS,
  type BackgroundJob, type BackgroundJobChange, type BackgroundJobKind, type BackgroundJobOutput, type BackgroundJobStatus,
} from "../../contracts/src/background-job.ts";
import type { DreamChangeEvent, DreamStatus } from "../../contracts/src/dream.ts";
import type { SyncStatusResponse } from "../../contracts/src/sync.ts";
import type { TransferChangeEvent } from "../../contracts/src/transfer.ts";
import type { WorkflowRunProgress } from "../../contracts/src/workflow-run.ts";
import {
  agentJobTitle, agentProgressDetail, compareJobs, firstLine, jobIdOf, transferJobFields, workflowProgressOf,
} from "../../core/src/domain/background-jobs.ts";
import type { BackgroundTaskUpdate } from "../backends/sdk/SdkEventMapper.ts";

// Every background job, in memory: an agent's background shells, Monitors,
// subagents and Workflow runs, `!` commands, and Eos's transfers, compaction,
// dreams and sync. Each source reports here (wired in jobs/wireJobSources.ts);
// changes go out as jobs:change, at most every throttleMs per job except a
// start or an end, which go at once. Finished jobs are kept (newest finishedMax)
// until dismissed; compaction and sync are only shown while they run.

interface StopCapable {
  isAlive(): boolean;
  stopTask?(taskId: string): Promise<{ ok: boolean; reason?: string }>;
}

// How a job is stopped: a session task (shell, Monitor, agent, Workflow) goes
// through the session that runs it.
type Source =
  | { type: "task"; taskId: string }
  | { type: "terminal"; runId: string }
  | { type: "transfer"; id: string }
  | { type: "dream" }
  | { type: "none" };

interface Entry {
  job: BackgroundJob;
  source: Source;
  outputFile: string | null;
  // In-memory output (a `!` command's chunks, a Monitor's events); memBase is
  // the offset of mem's first character in the whole output.
  mem: string | null;
  memBase: number;
  events: number;
  ambient: boolean;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface BackgroundJobServiceDeps {
  bus: Pick<EventBus, "publish">;
  session(workerId: string): StopCapable | null;
  cancelTransfer(id: string): void;
  stopDream(): boolean;
  killTerminal(runId: string): boolean;
  machineName(ref: string): string;
  now?(): number;
  throttleMs?: number;
  finishedMax?: number;
  // A sync pass shorter than this never shows.
  syncShowMs?: number;
}

export type JobActionResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

const MEM_MAX = 256 * 1024;

export class BackgroundJobService {
  private entries = new Map<string, Entry>();
  // `${workerId}\0${taskId}` and `run\0${runId}` → job id.
  private byRef = new Map<string, string>();
  private dreamJobId: string | null = null;
  private dreamSeq = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private deps: BackgroundJobServiceDeps;
  private now: () => number;
  private throttleMs: number;
  private finishedMax: number;

  constructor(deps: BackgroundJobServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.throttleMs = deps.throttleMs ?? 500;
    this.finishedMax = deps.finishedMax ?? 50;
  }

  list(): BackgroundJob[] {
    return [...this.entries.values()].map((e) => this.snapshot(e)).sort(compareJobs);
  }

  // ---- sources ------------------------------------------------------------

  onBackgroundTask(workerId: string, u: BackgroundTaskUpdate): void {
    if (u.phase === "started") {
      const e = this.start(u.kind, workerId, u.taskId, { title: u.title, command: u.command, callId: u.callId }, { type: "task", taskId: u.taskId });
      e.outputFile = u.outputFile;
      if (u.kind === "monitor") e.mem = "";
      this.byRef.set(`${workerId}\0${u.taskId}`, e.job.id);
      this.send(e);
      return;
    }
    const e = this.byTask(workerId, u.taskId);
    if (!e) return;
    if (u.phase === "output") {
      e.outputFile = u.outputFile;
      this.send(e);
    } else if (u.phase === "event") {
      e.events++;
      this.appendMem(e, `${u.text}\n`);
      const last = firstLine(u.text);
      this.update(e, { detail: `${e.events} event${e.events === 1 ? "" : "s"}${last ? ` · ${last}` : ""}` });
    } else if (u.phase === "progress") {
      const detail = agentProgressDetail(u.lastTool, u.toolUses);
      if (detail && e.job.status === "running") this.update(e, { detail });
    } else {
      if (u.outputFile) e.outputFile = u.outputFile;
      // A shell can report "completed" for a command that exited non-zero.
      const status = u.status === "completed" && u.exitCode !== null && u.exitCode !== 0 ? "failed" : u.status;
      this.finish(e, status, { detail: firstLine(u.summary) ?? e.job.detail, exitCode: u.exitCode });
    }
  }

  // A worker's agent events: background subagents and Workflow runs start and end here.
  observe(workerId: string, event: AgentEvent): void {
    if (event.type === "subagent_started") {
      const e = this.start("agent", workerId, event.agentId, {
        title: agentJobTitle(event.agentType, event.description), command: null, callId: event.resumes ?? event.callId,
      }, { type: "task", taskId: event.agentId });
      this.byRef.set(`${workerId}\0${event.agentId}`, e.job.id);
      this.send(e);
    } else if (event.type === "subagent_completed") {
      const e = this.byTask(workerId, event.agentId);
      const toolUses = event.usage?.toolUses;
      if (e) this.finish(e, event.status, { detail: firstLine(event.result) ?? (toolUses ? agentProgressDetail(null, toolUses) : e.job.detail) });
    } else if (event.type === "workflow_started") {
      const e = this.start("workflow", workerId, event.callId, {
        title: event.name ?? event.description ?? "Workflow", command: null, callId: event.callId,
      }, { type: "task", taskId: event.taskId });
      this.byRef.set(`${workerId}\0${event.taskId}`, e.job.id);
      this.send(e);
    } else if (event.type === "workflow_completed") {
      const e = this.entries.get(jobIdOf("workflow", workerId, event.callId));
      if (!e) return;
      const fromSnapshot = event.snapshot ? workflowProgressOf(event.snapshot).detail : null;
      this.finish(e, event.status, { detail: firstLine(event.summary) ?? fromSnapshot ?? e.job.detail });
    }
  }

  onWorkflowProgress(p: WorkflowRunProgress): void {
    const e = this.entries.get(jobIdOf("workflow", p.workerId, p.callId));
    if (e?.job.status === "running") this.update(e, workflowProgressOf(p.snapshot));
  }

  onTerminalStart(p: { workerId: string | null; runId: string; command: string; startedAt: number }): void {
    const e = this.start("shell", p.workerId, `run-${p.runId}`, { title: p.command, command: p.command, callId: null }, { type: "terminal", runId: p.runId });
    e.job.startedAt = p.startedAt;
    e.mem = "";
    this.byRef.set(`run\0${p.runId}`, e.job.id);
    this.send(e);
  }

  onTerminalChunk(p: { runId: string; data: string }): void {
    const e = this.byRun(p.runId);
    if (!e) return;
    this.appendMem(e, p.data);
    const last = p.data.split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (last) this.update(e, { detail: firstLine(last) });
  }

  onTerminalDone(p: { runId: string; exitCode: number; note: string | null }): void {
    const e = this.byRun(p.runId);
    if (!e) return;
    const status: BackgroundJobStatus = p.note === "stopped by user" ? "stopped" : p.exitCode === 0 ? "completed" : "failed";
    this.finish(e, status, { detail: p.note ?? `exit ${p.exitCode}`, exitCode: p.exitCode });
  }

  onTransfer(change: TransferChangeEvent): void {
    for (const id of change.removed ?? []) this.drop(jobIdOf("transfer", null, id));
    const t = change.transfer;
    if (!t) return;
    const id = jobIdOf("transfer", null, t.id);
    const fields = transferJobFields(t, this.deps.machineName);
    let e = this.entries.get(id);
    // A transfer that ended before this registry saw it is history, not a job.
    if (!e && fields.status !== "running") return;
    if (!e) {
      e = this.start("transfer", null, t.id, { title: fields.title, command: null, callId: null }, { type: "transfer", id: t.id });
      e.job.workerId = t.origin.agentId ?? null;
      e.job.startedAt = t.startedAt ?? t.createdAt;
    }
    if (fields.status === "running") this.update(e, { title: fields.title, detail: fields.detail, progress: fields.progress }, e.sentAt === -Infinity);
    else this.finish(e, fields.status, { title: fields.title, detail: fields.detail, progress: null });
  }

  onDream(change: DreamChangeEvent, status: DreamStatus): void {
    const progress = status.progress;
    if (status.running) {
      let e = this.dreamJobId ? this.entries.get(this.dreamJobId) : undefined;
      const isNew = !e;
      if (!e) {
        e = this.start("dream", null, `run-${++this.dreamSeq}`, { title: "Dreaming", command: null, callId: null }, { type: "dream" });
        this.dreamJobId = e.job.id;
      }
      const total = progress?.total ?? 0;
      this.update(e, {
        title: total ? `Dreaming over ${total} chat${total === 1 ? "" : "s"}` : "Dreaming",
        detail: progress ? `Read ${progress.done} of ${progress.total}` : null,
        progress: progress && progress.total ? { done: progress.done, total: progress.total } : null,
      }, isNew);
      return;
    }
    const e = this.dreamJobId ? this.entries.get(this.dreamJobId) : undefined;
    this.dreamJobId = null;
    if (!e) return;
    if (change.status === "skipped") { this.drop(e.job.id); return; }
    const end: BackgroundJobStatus = change.status === "failed" ? "failed" : change.status === "stopped" ? "stopped" : "completed";
    this.finish(e, end, { progress: null });
  }

  onSync(status: SyncStatusResponse): void {
    const id = jobIdOf("sync", null, "sync");
    if (status.phase !== "syncing") {
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.drop(id);
      return;
    }
    if (this.syncTimer || this.entries.has(id)) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      const e = this.start("sync", null, "sync", { title: "Syncing", command: null, callId: null }, { type: "none" });
      e.ambient = true;
      this.send(e);
    }, this.deps.syncShowMs ?? 1500);
  }

  onCompaction(workerId: string, running: boolean): void {
    const id = jobIdOf("compaction", workerId, "context");
    if (!running) { this.drop(id); return; }
    const e = this.start("compaction", workerId, "context", { title: "Compacting context", command: null, callId: null }, { type: "none" });
    e.ambient = true;
    this.send(e);
  }

  // A worker row is gone for good: its jobs have nothing left to link to.
  forgetWorker(workerId: string): void {
    for (const e of [...this.entries.values()]) if (e.job.workerId === workerId) this.drop(e.job.id);
  }

  // ---- the user's actions -------------------------------------------------

  output(id: string, since: number): BackgroundJobOutput | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.mem !== null) return sliceOutput(e.mem, e.memBase, since);
    return e.outputFile ? readFileOutput(e.outputFile, since) : null;
  }

  async stop(id: string): Promise<JobActionResult> {
    const e = this.entries.get(id);
    if (!e || e.job.status !== "running") return { ok: false, status: 404, error: "no running job with that id" };
    const s = e.source;
    if (s.type === "task") {
      const session = e.job.workerId ? this.deps.session(e.job.workerId) : null;
      if (!session?.stopTask || !session.isAlive()) return { ok: false, status: 409, error: "this session can't stop that job" };
      const r = await session.stopTask(s.taskId);
      return r.ok ? { ok: true } : { ok: false, status: 409, error: r.reason ?? "stop failed" };
    }
    if (s.type === "terminal") return this.deps.killTerminal(s.runId) ? { ok: true } : { ok: false, status: 409, error: "the command already ended" };
    if (s.type === "dream") return this.deps.stopDream() ? { ok: true } : { ok: false, status: 409, error: "no dream to stop" };
    if (s.type === "transfer") {
      try { this.deps.cancelTransfer(s.id); return { ok: true }; }
      catch (err) { return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) }; }
    }
    return { ok: false, status: 409, error: "that job can't be stopped" };
  }

  dismiss(id: string): JobActionResult {
    const e = this.entries.get(id);
    if (!e || e.job.status === "running") return { ok: false, status: 404, error: "no finished job with that id" };
    this.drop(id);
    return { ok: true };
  }

  clearFinished(): void {
    const ids = [...this.entries.values()].filter((e) => e.job.status !== "running").map((e) => e.job.id);
    for (const id of ids) this.remove(id);
    if (ids.length) this.publish({ removed: ids });
  }

  dispose(): void {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.entries.clear();
    this.byRef.clear();
  }

  // ---- internals ----------------------------------------------------------

  // A new job, or the same one started again (a resumed subagent).
  private start(kind: BackgroundJobKind, workerId: string | null, ref: string, f: { title: string; command: string | null; callId: string | null }, source: Source): Entry {
    const id = jobIdOf(kind, workerId, ref);
    const prev = this.entries.get(id);
    if (prev?.timer) clearTimeout(prev.timer);
    const e: Entry = {
      job: {
        id, kind, status: "running", workerId, title: f.title, command: f.command, detail: null,
        startedAt: this.now(), endedAt: null, progress: null, exitCode: null, callId: f.callId,
        hasOutput: false, canStop: false,
      },
      source, outputFile: null, mem: null, memBase: 0, events: 0, ambient: false, sentAt: -Infinity, timer: null,
    };
    this.entries.set(id, e);
    return e;
  }

  private update(e: Entry, patch: Partial<BackgroundJob>, immediate = false): void {
    Object.assign(e.job, patch);
    const wait = e.sentAt + this.throttleMs - this.now();
    if (immediate || wait <= 0) this.send(e);
    else if (!e.timer) e.timer = setTimeout(() => this.send(e), wait);
  }

  private finish(e: Entry, status: BackgroundJobStatus, patch: Partial<BackgroundJob>): void {
    if (e.ambient) { this.drop(e.job.id); return; }
    const wasRunning = e.job.status === "running";
    Object.assign(e.job, patch, { status, ...(wasRunning ? { endedAt: this.now() } : {}) });
    this.send(e);
    if (wasRunning) this.pruneFinished();
  }

  private send(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.sentAt = this.now();
    if (this.entries.get(e.job.id) !== e) return;
    this.publish({ job: this.snapshot(e) });
  }

  private snapshot(e: Entry): BackgroundJob {
    const running = e.job.status === "running";
    return { ...e.job, hasOutput: e.mem !== null || e.outputFile !== null, canStop: running && this.stoppable(e) };
  }

  private stoppable(e: Entry): boolean {
    if (e.source.type === "none") return false;
    if (e.source.type !== "task") return true;
    const session = e.job.workerId ? this.deps.session(e.job.workerId) : null;
    return session?.stopTask !== undefined && session.isAlive();
  }

  private appendMem(e: Entry, text: string): void {
    e.mem = (e.mem ?? "") + text;
    if (e.mem.length > MEM_MAX) {
      const cut = e.mem.length - MEM_MAX;
      e.mem = e.mem.slice(cut);
      e.memBase += cut;
    }
  }

  private pruneFinished(): void {
    const finished = [...this.entries.values()].filter((e) => e.job.status !== "running")
      .sort((a, b) => (b.job.endedAt ?? 0) - (a.job.endedAt ?? 0));
    const extra = finished.slice(this.finishedMax).map((e) => e.job.id);
    for (const id of extra) this.remove(id);
    if (extra.length) this.publish({ removed: extra });
  }

  private drop(id: string): void {
    if (this.remove(id)) this.publish({ removed: [id] });
  }

  private remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.timer) clearTimeout(e.timer);
    this.entries.delete(id);
    for (const [ref, jobId] of this.byRef) if (jobId === id) this.byRef.delete(ref);
    if (this.dreamJobId === id) this.dreamJobId = null;
    return true;
  }

  private byTask(workerId: string, taskId: string): Entry | undefined {
    const id = this.byRef.get(`${workerId}\0${taskId}`);
    return id ? this.entries.get(id) : undefined;
  }

  private byRun(runId: string): Entry | undefined {
    const id = this.byRef.get(`run\0${runId}`);
    return id ? this.entries.get(id) : undefined;
  }

  private publish(change: BackgroundJobChange): void {
    this.deps.bus.publish(BACKGROUND_JOB_TOPICS.change, change);
  }
}

// The part of an output after `since`, at most BACKGROUND_JOB_OUTPUT_MAX of its newest.
export function sliceOutput(text: string, base: number, since: number): BackgroundJobOutput {
  const end = base + text.length;
  const reset = since > end;
  let start = reset ? base : Math.max(since, base);
  let truncated = start > since && !reset;
  if (end - start > BACKGROUND_JOB_OUTPUT_MAX) { start = end - BACKGROUND_JOB_OUTPUT_MAX; truncated = true; }
  return { text: text.slice(start - base), next: end, truncated, reset };
}

function readFileOutput(path: string, since: number): BackgroundJobOutput | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const reset = since > size;
    let start = reset ? 0 : since;
    let truncated = false;
    if (size - start > BACKGROUND_JOB_OUTPUT_MAX) { start = size - BACKGROUND_JOB_OUTPUT_MAX; truncated = true; }
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString("utf8"), next: size, truncated, reset };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
