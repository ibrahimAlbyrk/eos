// MicroTaskRunner — the scheduler + state machine behind the micro-task
// subsystem. It subscribes each enabled task's trigger topic, debounces a run
// per (task, entity) by a configurable delay, then drives the task through
// gate → extract → render → one-shot LLM → apply. Everything is fail-closed:
// a throwing gate/extract/LLM/apply is swallowed (logged), never crashing the
// daemon and never re-running an entity it already handled.
//
// pause/resume let a caller hold a scheduled run while a competing intent is in
// flight (e.g. a human is renaming the same entity); a lost resume can't pause
// forever — every pause arms a drop-safety deadline (pauseMaxMs) that auto-
// resumes. NO heartbeat. The actual LLM call reuses the dynamic-loop one-shot
// path through the injected OneShotClient (zero new LLM infra).

import type { MicroTask, MicroTaskContext } from "../../core/src/ports/MicroTask.ts";
import type { OneShotClient } from "../../core/src/ports/OneShotClient.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

// The runtime view of a task's config (config.microTasks.tasks[id]). charLimit
// is consumed by a task's extract() to bound prompt inputs; the runner only
// surfaces it via configFor. promptTemplate, when set, overrides the catalog
// prompt with an inline body rendered through prompts.renderInline.
export interface MicroTaskRunConfig {
  enabled: boolean;
  delayMs: number;
  model: string;
  charLimit: number;
  promptTemplate?: string;
}

// The narrow slice of PromptService the runner needs (a real PromptService
// satisfies this structurally). render() looks up a catalog id; renderInline()
// renders a config-supplied template body.
export interface MicroTaskPrompts {
  render(id: string, locals?: Record<string, string>): string;
  renderInline(body: string, locals?: Record<string, string>): string;
}

export interface MicroTaskRunnerDeps {
  bus: EventBus;
  oneShot: OneShotClient;
  prompts: MicroTaskPrompts;
  clock: Clock;
  log: Logger;
  tasks: MicroTask[];
  subsystemEnabled(): boolean;
  configFor(taskId: string): MicroTaskRunConfig;
  // The drop-safety deadline (config.microTasks.pauseMaxMs); read live so a
  // config reload takes effect on the next pause.
  pauseMaxMs(): number;
}

interface RunState {
  taskId: string;
  entityId: string;
  phase: "scheduled" | "paused";
  timer?: ReturnType<typeof setTimeout>;
  pauseTimer?: ReturnType<typeof setTimeout>;
  remainingMs: number;
  deadline: number;
}

function keyOf(taskId: string, entityId: string): string {
  return `${taskId}::${entityId}`;
}

function readWorkerId(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const id = (payload as { workerId?: unknown }).workerId;
    if (typeof id === "string") return id;
  }
  return null;
}

export class MicroTaskRunner {
  private readonly deps: MicroTaskRunnerDeps;
  private readonly taskById: Map<string, MicroTask>;
  private readonly runs = new Map<string, RunState>();
  // Once-only-per-(task, entity): a key here was scheduled-and-fired, gate-denied,
  // or cancelled — never act on it again for this runner's lifetime.
  private readonly seen = new Set<string>();
  // Re-entrancy guard around fire() so a key can't be in flight twice.
  private readonly ticking = new Set<string>();
  // Sticky "pause arrived before the trigger" flag, keyed like a run.
  private readonly pausedKeys = new Set<string>();
  private unsubs: Array<() => void> = [];
  private started = false;

  constructor(deps: MicroTaskRunnerDeps) {
    this.deps = deps;
    this.taskById = new Map(deps.tasks.map((t) => [t.id, t]));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.deps.tasks) {
      if (!this.deps.configFor(task.id).enabled) continue;
      const unsub = this.deps.bus.subscribe(task.trigger.topic, (msg) => {
        void this.onEvent(task, msg.payload);
      });
      this.unsubs.push(unsub);
    }
    this.unsubs.push(this.deps.bus.subscribe("worker:exit", (msg) => this.onWorkerExit(msg.payload)));
  }

  stop(): void {
    for (const unsub of this.unsubs) {
      try { unsub(); } catch { /* best-effort */ }
    }
    this.unsubs = [];
    for (const run of this.runs.values()) {
      clearTimeout(run.timer);
      clearTimeout(run.pauseTimer);
    }
    this.runs.clear();
    this.started = false;
  }

  pause(taskId: string, entityId: string): void {
    const key = keyOf(taskId, entityId);
    const run = this.runs.get(key);
    if (!run) {
      // Pause before the trigger — onEvent will store the run already paused.
      this.pausedKeys.add(key);
      return;
    }
    if (run.phase === "paused") return;
    clearTimeout(run.timer);
    run.timer = undefined;
    run.remainingMs = Math.max(0, run.deadline - this.deps.clock.now());
    run.phase = "paused";
    run.pauseTimer = this.armPauseTimer(taskId, entityId);
  }

  resume(taskId: string, entityId: string): void {
    const key = keyOf(taskId, entityId);
    this.pausedKeys.delete(key);
    const run = this.runs.get(key);
    if (!run || run.phase !== "paused") return;
    clearTimeout(run.pauseTimer);
    run.pauseTimer = undefined;
    this.schedule(taskId, entityId, run.remainingMs);
  }

  cancel(taskId: string, entityId: string, reason: string): void {
    const key = keyOf(taskId, entityId);
    const run = this.runs.get(key);
    if (run) {
      clearTimeout(run.timer);
      clearTimeout(run.pauseTimer);
    }
    this.runs.delete(key);
    this.pausedKeys.delete(key);
    this.seen.add(key);
    this.deps.log.debug("micro-task cancelled", { taskId, entityId, reason });
  }

  private async onEvent(task: MicroTask, payload: unknown): Promise<void> {
    const entityId = task.trigger.match(payload);
    if (entityId == null) return;
    const key = keyOf(task.id, entityId);
    // Already handled (seen) or already scheduled/paused (no double-arm).
    if (this.seen.has(key) || this.runs.has(key)) return;
    if (!this.deps.subsystemEnabled() || !this.deps.configFor(task.id).enabled) return;

    const ctx: MicroTaskContext = { entityId, now: this.deps.clock.now() };
    let pass = false;
    try {
      pass = await task.gate(ctx);
    } catch (e) {
      // A throwing gate is fail-closed AND terminal: don't retry an entity whose
      // precondition check itself errors.
      this.deps.log.warn("micro-task gate threw", { taskId: task.id, entityId, error: e instanceof Error ? e.message : String(e) });
      this.seen.add(key);
      return;
    }
    if (!pass) { this.seen.add(key); return; }
    // The awaited gate may have let an exit/cancel intervene.
    if (this.seen.has(key) || this.runs.has(key)) return;

    if (this.pausedKeys.has(key)) { this.storePaused(task.id, entityId); return; }
    this.schedule(task.id, entityId, this.deps.configFor(task.id).delayMs);
  }

  private onWorkerExit(payload: unknown): void {
    const entityId = readWorkerId(payload);
    if (entityId == null) return;
    for (const [key, run] of this.runs) {
      if (run.entityId !== entityId) continue;
      clearTimeout(run.timer);
      clearTimeout(run.pauseTimer);
      this.runs.delete(key);
    }
    for (const task of this.deps.tasks) this.pausedKeys.delete(keyOf(task.id, entityId));
  }

  private schedule(taskId: string, entityId: string, ms: number): void {
    const key = keyOf(taskId, entityId);
    const deadline = this.deps.clock.now() + ms;
    const timer = setTimeout(() => { void this.fire(key); }, ms);
    timer.unref?.();
    this.runs.set(key, { taskId, entityId, phase: "scheduled", timer, remainingMs: ms, deadline });
  }

  // Store a run that is paused before it ever scheduled (pause beat the trigger).
  // The full delay starts only once it resumes; until then the drop-safety timer
  // guarantees it can't stay paused forever.
  private storePaused(taskId: string, entityId: string): void {
    const key = keyOf(taskId, entityId);
    this.runs.set(key, {
      taskId,
      entityId,
      phase: "paused",
      pauseTimer: this.armPauseTimer(taskId, entityId),
      remainingMs: this.deps.configFor(taskId).delayMs,
      deadline: 0,
    });
  }

  private armPauseTimer(taskId: string, entityId: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => this.resume(taskId, entityId), this.deps.pauseMaxMs());
    t.unref?.();
    return t;
  }

  private async fire(key: string): Promise<void> {
    const run = this.runs.get(key);
    this.runs.delete(key);
    if (!run) return;
    if (this.ticking.has(key)) return;
    this.ticking.add(key);
    this.seen.add(key); // terminal: at most one fire per (task, entity)
    try {
      const task = this.taskById.get(run.taskId);
      if (!task) return;
      const ctx: MicroTaskContext = { entityId: run.entityId, now: this.deps.clock.now() };
      if (!(await task.gate(ctx))) return;
      const vars = await task.extract(ctx);
      if (vars == null) return;
      const cfg = this.deps.configFor(run.taskId);
      const prompt = cfg.promptTemplate
        ? this.deps.prompts.renderInline(cfg.promptTemplate, vars)
        : this.deps.prompts.render(task.promptId, vars);
      const out = await this.deps.oneShot.complete(prompt.trim(), { model: cfg.model });
      await task.apply(ctx, out);
    } catch (e) {
      this.deps.log.warn("micro-task failed", { key, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.ticking.delete(key);
    }
  }
}
