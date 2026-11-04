import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import {
  BACKGROUND_JOB_OUTPUT_MAX, BACKGROUND_JOB_TOPICS,
  type BackgroundJob, type BackgroundJobChange, type BackgroundJobKind, type BackgroundJobOutput, type BackgroundJobStatus,
} from "../../../contracts/src/background-job.ts";
import { compareJobs, jobIdOf } from "../../../core/src/domain/background-jobs.ts";

// Every background job, in memory, for the header beacon and the Jobs tab. The
// registry knows nothing about what a job is: whoever runs something in the
// background (an agent's shells and Workflows, `!` commands, transfers, dreams,
// sync, compaction, updates — see ./sources) starts a job here, updates it, ends
// it, and says how to stop it. Changes go out as jobs:change, at most every
// throttleMs per job except a start or an end, which go at once. Finished jobs
// are kept (newest finishedMax) until dismissed; an ambient job (compaction,
// sync, an update download) shows only while it runs.

export type JobActionResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

export interface JobSpec {
  readonly kind: BackgroundJobKind;
  readonly workerId: string | null;
  // Unique among this kind's jobs of the same worker.
  readonly ref: string;
  readonly title: string;
  readonly command?: string | null;
  readonly callId?: string | null;
  readonly startedAt?: number;
  readonly ambient?: boolean;
  // Output kept in memory (appendOutput) — otherwise only a file's (setOutputFile).
  readonly memoryOutput?: boolean;
  // How the user stops it; absent = it can't be stopped.
  readonly stop?: () => JobActionResult | Promise<JobActionResult>;
  // Whether stopping is possible right now (default: whenever `stop` is given).
  readonly canStop?: () => boolean;
}

export interface JobHandle {
  readonly id: string;
  readonly job: Readonly<BackgroundJob>;
  update(patch: Partial<BackgroundJob>, immediate?: boolean): void;
  finish(status: BackgroundJobStatus, patch?: Partial<BackgroundJob>): void;
  appendOutput(text: string): void;
  setOutputFile(path: string | null): void;
  drop(): void;
}

export interface JobRegistryDeps {
  bus: Pick<EventBus, "publish">;
  now?(): number;
  throttleMs?: number;
  finishedMax?: number;
}

const MEM_MAX = 256 * 1024;

interface Entry {
  job: BackgroundJob;
  spec: JobSpec;
  outputFile: string | null;
  // In-memory output; memBase is the offset of mem's first character in the whole output.
  mem: string | null;
  memBase: number;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class JobRegistry {
  private entries = new Map<string, Entry>();
  private deps: JobRegistryDeps;
  private now: () => number;
  private throttleMs: number;
  private finishedMax: number;

  constructor(deps: JobRegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.throttleMs = deps.throttleMs ?? 500;
    this.finishedMax = deps.finishedMax ?? 50;
  }

  list(): BackgroundJob[] {
    return [...this.entries.values()].map((e) => this.snapshot(e)).sort(compareJobs);
  }

  // A new job, or the same one (same kind, worker and ref) started again. Nothing
  // goes out until the caller's first update/send — so it can fill the job in first.
  start(spec: JobSpec): JobHandle {
    const id = jobIdOf(spec.kind, spec.workerId, spec.ref);
    const prev = this.entries.get(id);
    if (prev?.timer) clearTimeout(prev.timer);
    const e: Entry = {
      job: {
        id, kind: spec.kind, status: "running", workerId: spec.workerId, title: spec.title, command: spec.command ?? null,
        detail: null, startedAt: spec.startedAt ?? this.now(), endedAt: null, progress: null, exitCode: null,
        callId: spec.callId ?? null, hasOutput: false, canStop: false,
      },
      spec, outputFile: null, mem: spec.memoryOutput ? "" : null, memBase: 0, sentAt: -Infinity, timer: null,
    };
    this.entries.set(id, e);
    return this.handle(e);
  }

  get(kind: BackgroundJobKind, workerId: string | null, ref: string): JobHandle | null {
    const e = this.entries.get(jobIdOf(kind, workerId, ref));
    return e ? this.handle(e) : null;
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
    if (!e.spec.stop) return { ok: false, status: 409, error: "that job can't be stopped" };
    return e.spec.stop();
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

  // A worker row is gone for good: its jobs have nothing left to link to.
  forgetWorker(workerId: string): void {
    for (const e of [...this.entries.values()]) if (e.job.workerId === workerId) this.drop(e.job.id);
  }

  dispose(): void {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
  }

  // ---- internals ----------------------------------------------------------

  private handle(e: Entry): JobHandle {
    return {
      id: e.job.id,
      job: e.job,
      update: (patch, immediate = false) => this.update(e, patch, immediate),
      finish: (status, patch = {}) => this.finish(e, status, patch),
      appendOutput: (text) => this.appendMem(e, text),
      setOutputFile: (path) => { e.outputFile = path; },
      drop: () => { if (this.entries.get(e.job.id) === e) this.drop(e.job.id); },
    };
  }

  private update(e: Entry, patch: Partial<BackgroundJob>, immediate: boolean): void {
    Object.assign(e.job, patch);
    const wait = e.sentAt + this.throttleMs - this.now();
    if (immediate || wait <= 0) this.send(e);
    else if (!e.timer) e.timer = setTimeout(() => this.send(e), wait);
  }

  private finish(e: Entry, status: BackgroundJobStatus, patch: Partial<BackgroundJob>): void {
    if (e.spec.ambient) { this.drop(e.job.id); return; }
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
    const stoppable = Boolean(e.spec.stop) && (e.spec.canStop?.() ?? true);
    return { ...e.job, hasOutput: e.mem !== null || e.outputFile !== null, canStop: running && stoppable };
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
    return true;
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
