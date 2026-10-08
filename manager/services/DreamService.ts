// DreamService — when to dream, and one dream at a time. A 60 s tick checks the
// schedule (tonight's slot, or an away stretch); "Dream now" runs on demand. Guards
// before any model call: a Claude sign-in (a dream never bills an API key) and plan
// usage under the user's line — a held-off night is logged as skipped. While a
// scheduled dream runs, the user coming back stops it after the current chat.
// Publishes dream:change on every step; the morning note goes out when a dream filed
// proposals.

import type { Clock } from "../../core/src/ports/Clock.ts";
import type { DreamRepo } from "../../core/src/ports/DreamRepo.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import { emptyDreamDropped, isAwayDue, isNightlyDue, nextNightly } from "../../core/src/domain/dream.ts";
import type {
  DreamBlock, DreamChangeEvent, DreamProgress, DreamRun, DreamRunStatus, DreamStatus, DreamTrigger,
} from "../../contracts/src/dream.ts";
import type { DreamingSettings } from "../../contracts/src/profile.ts";

export interface DreamRunOptions {
  readonly trigger: DreamTrigger;
  readonly onProgress: (p: DreamProgress) => void;
  readonly shouldStop: () => boolean;
}

export interface DreamServiceDeps {
  readonly run: (opts: DreamRunOptions) => Promise<DreamRun>;
  readonly repo: Pick<DreamRepo, "latest" | "save">;
  readonly settings: () => DreamingSettings;
  readonly clock: Clock;
  readonly bus: Pick<EventBus, "publish">;
  readonly signedIn: () => boolean;
  // The busiest Claude plan window, 0–1; null when unknown.
  readonly usage: () => Promise<number | null>;
  readonly anyWorking: () => boolean;
  readonly newId: () => string;
  readonly notify: (run: DreamRun) => void;
  readonly log: Logger;
}

interface Running {
  readonly trigger: DreamTrigger;
  progress: DreamProgress | null;
  stop: boolean;
}

export class DreamService {
  private readonly deps: DreamServiceDeps;
  private running: Running | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // When Dreaming was last switched on — so turning it on in the afternoon waits
  // for tonight instead of dreaming at once.
  private enabledAt = 0;
  private wasEnabled: boolean | null = null;
  private lastUserAt: number;

  constructor(deps: DreamServiceDeps) {
    this.deps = deps;
    this.lastUserAt = deps.clock.now();
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // A top-level chat started working — the user is here.
  noteUserActivity(): void {
    this.lastUserAt = this.deps.clock.now();
    if (this.running && this.running.trigger !== "manual") this.running.stop = true;
  }

  requestStop(): boolean {
    if (!this.running) return false;
    this.running.stop = true;
    return true;
  }

  status(): DreamStatus {
    const s = this.deps.settings();
    return {
      running: this.running !== null,
      runId: null,
      progress: this.running?.progress ?? null,
      lastRun: this.deps.repo.latest(),
      nextAt: this.nextAt(s),
      blocked: this.blocked(s),
    };
  }

  async tick(): Promise<void> {
    const s = this.deps.settings();
    const now = this.deps.clock.now();
    if (s.enabled && (this.wasEnabled === false || (this.wasEnabled === null && !this.deps.repo.latest()))) this.enabledAt = now;
    this.wasEnabled = s.enabled;
    if (!s.enabled || this.running || s.schedule === "manual") return;
    if (this.isDue(s, now)) await this.begin(s.schedule === "nightly" ? "nightly" : "away");
  }

  // Starts a dream in the background; the caller polls status / listens for dream:change.
  dreamNow(): { started: boolean; reason?: string } {
    if (this.running) return { started: false, reason: "A dream is already running" };
    void this.begin("manual");
    return { started: true };
  }

  private since(): number {
    return Math.max(this.deps.repo.latest()?.startedAt ?? 0, this.enabledAt);
  }

  private isDue(s: DreamingSettings, now: number): boolean {
    if (s.schedule === "nightly") return isNightlyDue(now, s.nightlyAt, this.since());
    return isAwayDue(now, s.awayMinutes, this.lastUserAt, this.deps.anyWorking(), this.since());
  }

  private nextAt(s: DreamingSettings): number | null {
    if (!s.enabled || s.schedule !== "nightly") return null;
    const now = this.deps.clock.now();
    return isNightlyDue(now, s.nightlyAt, this.since()) ? now : nextNightly(now, s.nightlyAt);
  }

  private blocked(s: DreamingSettings): DreamBlock | null {
    if (!s.enabled) return "disabled";
    if (!this.deps.signedIn()) return "sign-in";
    return null;
  }

  private async begin(trigger: DreamTrigger): Promise<void> {
    if (this.running) return;
    const s = this.deps.settings();
    if (!this.deps.signedIn()) {
      this.skip(trigger, s, "Needs a Claude sign-in — dreams run on your plan, never an API key");
      return;
    }
    const used = await this.deps.usage().catch(() => null);
    if (used !== null && used >= s.usageCeiling) {
      this.skip(trigger, s, `Held off — plan usage at ${Math.round(used * 100)}%, above your ${Math.round(s.usageCeiling * 100)}% line`);
      return;
    }
    const running: Running = { trigger, progress: null, stop: false };
    this.running = running;
    this.publish(null, "running");
    try {
      const run = await this.deps.run({
        trigger,
        onProgress: (p) => { running.progress = p; this.publish(null, "running"); },
        shouldStop: () => running.stop,
      });
      if (run.proposed > 0 && s.morningNote) this.deps.notify(run);
      this.running = null;
      this.publish(run.id, run.status);
    } catch (e) {
      this.deps.log.warn("dream failed", { error: e instanceof Error ? e.message : String(e) });
      this.running = null;
      this.publish(null, "failed");
    }
  }

  private skip(trigger: DreamTrigger, s: DreamingSettings, reason: string): void {
    const now = this.deps.clock.now();
    const run: DreamRun = {
      id: this.deps.newId(), trigger, status: "skipped", reason, startedAt: now, finishedAt: now, model: s.model,
      chatsRead: 0, observations: 0, proposed: 0, tokens: 0, narrative: null,
      dropped: emptyDreamDropped(), chats: [], candidates: 0, rejected: [],
    };
    this.deps.repo.save(run);
    this.publish(run.id, "skipped");
  }

  private publish(runId: string | null, status: DreamRunStatus): void {
    const evt: DreamChangeEvent = { runId, status };
    this.deps.bus.publish("dream:change", evt);
  }
}
