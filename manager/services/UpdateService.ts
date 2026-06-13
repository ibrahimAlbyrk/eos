// UpdateService — periodically asks the UpdateSource whether the dedicated
// server has a newer build, caches the answer for the dashboard, and fires a
// one-shot SSE when a new update first appears so the web banner pops live.
// Applying is delegated to the UpdateApplier (a detached `git pull && eos
// build`). All state is in-memory: an applied update restarts the daemon, so a
// fresh service correctly re-derives "no update" on the next check — nothing
// needs to survive the restart. `deferred` is purely session-scoped banner
// suppression; the native launch splash keys on `available`, not on it.

import type { Clock } from "../../core/src/ports/Clock.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { UpdateSource } from "../../core/src/ports/UpdateSource.ts";
import type { UpdateApplier } from "../../core/src/ports/UpdateApplier.ts";
import type { UpdateStatus, UpdateApplyResponse } from "../../contracts/src/http.ts";

export interface UpdateServiceOpts {
  source: UpdateSource;
  applier: UpdateApplier;
  bus: EventBus;
  clock: Clock;
  repoRoot: string;
  enabled: boolean;
  log?: { info(msg: string, meta?: unknown): void };
}

function emptyStatus(enabled: boolean): UpdateStatus {
  return {
    enabled,
    available: false,
    deferred: false,
    dirty: false,
    behind: 0,
    branch: "",
    currentSha: "",
    latestSha: "",
    notes: [],
    checkedAt: null,
  };
}

export class UpdateService {
  private readonly o: UpdateServiceOpts;
  private status: UpdateStatus;
  private lastNotifiedSha: string | null = null;
  private checking: Promise<UpdateStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: UpdateServiceOpts) {
    this.o = o;
    this.status = emptyStatus(o.enabled);
  }

  /** Starts the background poll: a delayed first check (boot shouldn't wait on
   *  network I/O) then every intervalMs. No-op when disabled. unref'd so it
   *  never holds the process open. */
  start(intervalMs: number): void {
    if (!this.o.enabled || this.timer) return;
    const kick = setTimeout(() => void this.check(), 10_000);
    kick.unref?.();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** Force a fresh fetch + compare. Concurrent callers share one in-flight run
   *  so a banner click and the periodic tick can't double-fetch. */
  check(): Promise<UpdateStatus> {
    if (!this.o.enabled) return Promise.resolve(this.status);
    this.checking ??= this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async runCheck(): Promise<UpdateStatus> {
    const c = await this.o.source.check(this.o.repoRoot);
    const checkedAt = this.o.clock.now();
    if (!c) {
      this.status = { ...this.status, checkedAt };
      return this.status;
    }
    const available = c.behind > 0 && !c.dirty;
    this.status = {
      enabled: true,
      available,
      // Carry the dismissal only while the same update is still offered.
      deferred: available ? this.status.deferred : false,
      dirty: c.dirty,
      behind: c.behind,
      branch: c.branch,
      currentSha: c.currentSha,
      latestSha: c.latestSha,
      notes: c.notes,
      checkedAt,
    };
    // Pop the live banner only when a genuinely new latest appears — not on
    // every poll while the same update sits unapplied (the web already shows it).
    if (available && c.latestSha && c.latestSha !== this.lastNotifiedSha) {
      this.lastNotifiedSha = c.latestSha;
      this.o.bus.publish("update:available", { latestSha: c.latestSha, behind: c.behind });
    }
    return this.status;
  }

  /** "Later" — hide the banner for this daemon run. */
  defer(): UpdateStatus {
    this.status = { ...this.status, deferred: true };
    return this.status;
  }

  apply(relaunchApp: boolean): UpdateApplyResponse {
    if (!this.o.enabled) return { started: false, reason: "disabled" };
    // `available` already excludes a dirty tree; the applier's `git pull
    // --ff-only` is the apply-time guard against a tree that went dirty since.
    if (!this.status.available) return { started: false, reason: "not-available" };
    this.o.log?.info("applying update", { relaunchApp, latestSha: this.status.latestSha });
    this.o.applier.apply({ repoRoot: this.o.repoRoot, relaunchApp });
    return { started: true };
  }
}
