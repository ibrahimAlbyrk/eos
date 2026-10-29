// The daemon's side of in-app updates: checks the feed (soon after start, about
// every half hour, when Eos opens or the Mac wakes, and on Check now), downloads
// and stages a new release in the
// background, and — once the user says restart, now or when no agent is
// working — re-verifies the staged app and hands it to the Electron app over
// bus topic update:apply. The app quits; its applier swaps the bundle and the
// new version starts. Phases follow core/domain/update/status.ts; every change
// goes out as the whole UpdateState on update:change.

import {
  UPDATE_TOPICS,
  type UpdateApply, type UpdateCheckTrigger, type UpdateNotice, type UpdateOffReason, type UpdatePhase,
  type UpdatePointer, type UpdateState, type UpdateStatus,
} from "../../../contracts/src/update.ts";
import { UpdateError } from "../../../core/src/domain/update/errors.ts";
import { canUpdateTransition } from "../../../core/src/domain/update/status.ts";
import { isNewerVersion } from "../../../core/src/domain/update/version.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { StagedUpdate } from "../../../core/src/ports/Updates.ts";
import type { DownloadUpdateInput } from "../../../core/src/use-cases/update/DownloadUpdate.ts";
import type { UpdateInstall } from "./install.ts";

const FIRST_CHECK_MS = 30_000;
// A release reaches running apps within about this long; each install's own
// spread (±CHECK_JITTER) keeps them from all asking — and downloading — at once.
const CHECK_EVERY_MS = 30 * 60_000;
const CHECK_JITTER = 0.2;
// Eos opening or the Mac waking skips the check when one ran this recently.
const NUDGE_MIN_GAP_MS = 10 * 60_000;
// The app quits within seconds of update:apply; still up after this, it didn't take.
const APPLY_TIMEOUT_MS = 90_000;
const PROGRESS_EVERY_MS = 250;

export interface UpdateServiceDeps {
  readonly install: UpdateInstall | null;
  readonly off: UpdateOffReason | null;
  readonly check: (install: UpdateInstall) => Promise<UpdatePointer | null>;
  readonly download: (input: DownloadUpdateInput, signal: AbortSignal) => Promise<StagedUpdate>;
  // The last check before the swap: the staged app is still what was verified.
  readonly verifyStaged: (staged: string, installed: string) => Promise<void>;
  readonly workspace: {
    staged(): Promise<StagedUpdate | null>;
    clear(keep?: string): Promise<void>;
    result(): Promise<{ notice: UpdateNotice; dismissed: boolean } | null>;
    dismissResult(): Promise<void>;
    lastVersion(): Promise<string | null>;
    setLastVersion(version: string): Promise<void>;
  };
  readonly autoDownload: () => boolean;
  // Top-level agents in a turn right now.
  readonly workingAgents: () => number;
  readonly bus: Pick<EventBus, "publish">;
  readonly clock: Clock;
  readonly log: Logger;
  readonly random?: () => number;
}

export class UpdateService {
  private readonly deps: UpdateServiceDeps;
  private status: UpdateStatus;
  private lastCheckedAt: number | null = null;
  private notice: UpdateNotice | null = null;
  // A version that was rolled back is never fetched again on its own.
  private skipVersion: string | null = null;
  private offered: UpdatePointer | null = null;
  private staged: StagedUpdate | null = null;
  private downloading: AbortController | null = null;
  private nextCheck: ReturnType<typeof setTimeout> | null = null;
  private lastAttemptAt: number | null = null;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private progressSentAt = 0;

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps;
    this.status = deps.install ? statusOf("idle") : { ...statusOf("off"), off: deps.off };
  }

  async start(): Promise<void> {
    const { install } = this.deps;
    if (!install) return;
    // A rollback is on record before the old version opens again; an update
    // shows as this version being newer than the one that ran last (the
    // applier's own record lands only after the new version is up).
    const result = await this.deps.workspace.result();
    const last = await this.deps.workspace.lastVersion();
    await this.deps.workspace.setLastVersion(install.version);
    if (result?.notice.kind === "rolled-back") {
      this.skipVersion = result.notice.version;
      if (!result.dismissed) this.notice = result.notice;
    } else if (last && isNewerVersion(install.version, last)) {
      this.notice = { kind: "updated", version: install.version, from: last };
    }

    const staged = await this.deps.workspace.staged();
    if (staged && isNewerVersion(staged.version, install.version)) {
      this.staged = staged;
      this.set(this.readyStatus());
    } else {
      await this.deps.workspace.clear().catch(() => {});
    }
    this.scheduleCheck(FIRST_CHECK_MS);
  }

  stop(): void {
    if (this.nextCheck) clearTimeout(this.nextCheck);
    this.nextCheck = null;
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.downloading?.abort(new Error("shutdown"));
  }

  state(): UpdateState {
    return {
      current: this.deps.install?.version ?? null,
      status: this.status,
      lastCheckedAt: this.lastCheckedAt,
      autoDownload: this.deps.autoDownload(),
      notes: this.status.phase === "ready" || this.status.phase === "waiting" ? this.staged?.notes ?? null : null,
      notice: this.notice,
    };
  }

  // "scheduled" is the half-hourly timer; the next one counts from any check.
  async check(trigger: UpdateCheckTrigger | "scheduled" = "manual"): Promise<void> {
    const { install } = this.deps;
    if (!install || this.status.phase === "checking") return;
    const now = this.deps.clock.now();
    const nudge = trigger === "opened" || trigger === "woke";
    if (nudge && this.lastAttemptAt !== null && now - this.lastAttemptAt < NUDGE_MIN_GAP_MS) return;
    this.lastAttemptAt = now;
    this.scheduleCheck(this.jittered(CHECK_EVERY_MS));
    if (!canUpdateTransition(this.status.phase, "checking")) return;
    this.move(statusOf("checking", { version: this.staged?.version ?? null }));
    try {
      const pointer = await this.deps.check(install);
      this.lastCheckedAt = this.deps.clock.now();
      if (!pointer || pointer.version === this.staged?.version) {
        this.offered = pointer;
        this.move(this.staged ? this.readyStatus() : statusOf("idle"));
        return;
      }
      this.offered = pointer;
      if (this.deps.autoDownload() && pointer.version !== this.skipVersion) await this.download();
      else this.move(statusOf("available", { version: pointer.version }));
    } catch (e) {
      this.lastCheckedAt = this.deps.clock.now();
      this.fail(e);
    }
  }

  async download(): Promise<void> {
    const { install } = this.deps;
    const pointer = this.offered;
    if (!install || !pointer || this.downloading) return;
    if (!this.move(statusOf("downloading", { version: pointer.version, done: 0 }))) return;
    const ctl = new AbortController();
    this.downloading = ctl;
    this.staged = null;
    try {
      const staged = await this.deps.download({
        pointer,
        installedRoot: install.root,
        onProgress: (done, total) => this.progress(done, total),
        onStaging: () => { this.move(statusOf("staging", { version: pointer.version, bytes: this.status.bytes })); },
      }, ctl.signal);
      this.staged = staged;
      this.deps.log.info("update staged", { version: staged.version, bytes: staged.bytes });
      this.move(this.readyStatus());
    } catch (e) {
      if (ctl.signal.aborted) this.move(statusOf("available", { version: pointer.version }));
      else this.fail(e);
    } finally {
      this.downloading = null;
    }
  }

  // Restart now, or once no agent is working ("When they finish"). False when
  // nothing is ready to restart into.
  restart(when: "now" | "idle"): boolean {
    if ((this.status.phase !== "ready" && this.status.phase !== "waiting") || !this.staged) return false;
    const agents = this.deps.workingAgents();
    if (when === "idle" && agents > 0) return this.move({ ...this.readyStatus(), phase: "waiting", agents });
    void this.apply();
    return true;
  }

  // An agent started or finished a turn.
  agentsChanged(): void {
    if (this.status.phase !== "waiting") return;
    const agents = this.deps.workingAgents();
    if (agents === 0) void this.apply();
    else if (agents !== this.status.agents) this.set({ ...this.status, agents });
  }

  later(): void {
    if (this.status.phase === "waiting") this.move(this.readyStatus());
  }

  async dismissNotice(): Promise<void> {
    const rolledBack = this.notice?.kind === "rolled-back";
    this.notice = null;
    if (rolledBack) await this.deps.workspace.dismissResult().catch(() => {});
    this.publish();
  }

  // Auto-download was switched: start what was only offered, or stop what was running.
  settingsChanged(): void {
    if (this.deps.autoDownload() && this.status.phase === "available") void this.download();
    else if (!this.deps.autoDownload()) this.downloading?.abort(new Error("auto-download off"));
    else this.publish();
  }

  private async apply(): Promise<void> {
    const { install } = this.deps;
    const staged = this.staged;
    if (!install || !staged || !this.move({ ...this.readyStatus(), phase: "applying" })) return;
    try {
      await this.deps.verifyStaged(staged.path, install.root);
    } catch (e) {
      this.staged = null;
      await this.deps.workspace.clear().catch(() => {});
      this.fail(e);
      return;
    }
    const apply: UpdateApply = { version: staged.version, from: install.version, staged: staged.path, target: install.root };
    this.deps.log.info("update applying", apply);
    this.deps.bus.publish(UPDATE_TOPICS.apply, apply);
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      this.fail(new UpdateError("disk", "Eos didn't restart. Quit and open it again to finish the update."));
    }, APPLY_TIMEOUT_MS);
    this.applyTimer.unref?.();
  }

  private scheduleCheck(ms: number): void {
    if (this.nextCheck) clearTimeout(this.nextCheck);
    this.nextCheck = setTimeout(() => void this.check("scheduled"), ms);
    this.nextCheck.unref?.();
  }

  private jittered(ms: number): number {
    return Math.round(ms * (1 + CHECK_JITTER * (2 * (this.deps.random ?? Math.random)() - 1)));
  }

  private readyStatus(): UpdateStatus {
    return statusOf("ready", { version: this.staged?.version ?? null, bytes: this.staged?.bytes ?? null, full: this.staged?.full ?? null });
  }

  private progress(done: number, total: number): void {
    if (this.status.phase !== "downloading") return;
    this.status = { ...this.status, done, bytes: total };
    const now = this.deps.clock.now();
    if (done !== 0 && done !== total && now - this.progressSentAt < PROGRESS_EVERY_MS) return;
    this.progressSentAt = now;
    this.publish();
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.deps.log.warn("update failed", { phase: this.status.phase, error: message, code: e instanceof UpdateError ? e.code : null });
    this.move(statusOf("error", { version: this.offered?.version ?? this.status.version, error: message }));
  }

  private move(next: UpdateStatus): boolean {
    if (!canUpdateTransition(this.status.phase, next.phase)) {
      this.deps.log.warn("update transition refused", { from: this.status.phase, to: next.phase });
      return false;
    }
    this.set(next);
    return true;
  }

  private set(next: UpdateStatus): void {
    this.status = next;
    this.publish();
  }

  private publish(): void {
    this.deps.bus.publish(UPDATE_TOPICS.change, this.state());
  }
}

function statusOf(phase: UpdatePhase, fields: Partial<Omit<UpdateStatus, "phase">> = {}): UpdateStatus {
  return { phase, off: null, version: null, bytes: null, done: null, full: null, agents: null, error: null, ...fields };
}
