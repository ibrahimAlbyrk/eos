// PlanResumeService — "Resume at 16:40" on an accounts_exhausted row: one timer
// per agent, in memory (a daemon restart drops it). When it fires and the agent
// is still idle with nothing sent since the row, the session moves to the
// sign-in that came back and the turn picks up. The schedule rides the row's
// payload (resumeAt, then resumed), so every window shows it.

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { EventRepo } from "../../core/src/ports/EventRepo.ts";
import type { PlanLoginRecord } from "../../core/src/domain/plan-logins.ts";
import type { PlanLoginReader } from "../../core/src/services/PlanLoginService.ts";
import type { PlanLimitLedger } from "../../core/src/services/PlanLimitLedger.ts";
import { moveSession, type MoveSessionDeps } from "../../core/src/use-cases/SwitchSessionAccount.ts";

export interface PlanResumeServiceDeps extends Omit<MoveSessionDeps, "events" | "bus"> {
  events: Pick<EventRepo, "append" | "findById" | "patchPayload" | "list">;
  bus: Pick<EventBus, "publish">;
  logins: PlanLoginReader;
  ledger: PlanLimitLedger;
  signedIn(login: PlanLoginRecord): boolean;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

interface Exhausted {
  provider: string;
  nextResetAt?: string;
  resumeAt?: string;
  resumed?: boolean;
  [k: string]: unknown;
}

// The limit's own reset can land a little after the time it named.
const SLACK_MS = 30_000;
// What a resume looks back over for a message sent since the row.
const LOOKBACK_ROWS = 500;

export class PlanResumeService {
  private readonly deps: PlanResumeServiceDeps;
  private readonly timers = new Map<string, { rowId: number; timer: unknown }>();

  constructor(deps: PlanResumeServiceDeps) {
    this.deps = deps;
  }

  schedule(workerId: string, rowId: number): { ok: true } | { ok: false; error: string } {
    const row = this.exhausted(workerId, rowId);
    if (!row) return { ok: false, error: "not an exhausted-accounts row" };
    if (!row.payload.nextResetAt) return { ok: false, error: "no limit reset to wait for — sign in again instead" };
    this.clear(workerId);
    const at = Date.parse(row.payload.nextResetAt);
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    const timer = setTimer(() => void this.fire(workerId, rowId), Math.max(0, at - this.deps.clock.now()) + SLACK_MS);
    this.timers.set(workerId, { rowId, timer });
    this.patch(workerId, rowId, { ...row.payload, resumeAt: row.payload.nextResetAt });
    return { ok: true };
  }

  cancel(workerId: string, rowId: number): void {
    const row = this.exhausted(workerId, rowId);
    if (this.timers.get(workerId)?.rowId === rowId) this.clear(workerId);
    if (row?.payload.resumeAt) {
      const { resumeAt: _at, ...rest } = row.payload;
      this.patch(workerId, rowId, rest);
    }
  }

  private async fire(workerId: string, rowId: number): Promise<void> {
    this.timers.delete(workerId);
    const row = this.exhausted(workerId, rowId);
    if (!row) return;
    const { resumeAt: _at, ...rest } = row.payload;
    const state = String(this.deps.workers.findById(workerId)?.state ?? "").toUpperCase();
    const sentSince = this.deps.events.list({ workerId, since: 0, limit: LOOKBACK_ROWS, order: "asc", afterId: rowId })
      .some((e) => e.type === "user_message");
    const login = this.deps.logins.sessionLogin(row.payload.provider, (l) => this.deps.ledger.readiness(l.id, this.deps.signedIn(l)) === "ready");
    if (state !== "IDLE" || sentSince || !login) {
      this.deps.log.info("plan resume skipped", { workerId, state, sentSince, ready: Boolean(login) });
      this.patch(workerId, rowId, rest);
      return;
    }
    const moved = await moveSession(this.deps, workerId, { storeDir: login.storeDir }, { provider: row.payload.provider, to: login.label, reason: "reset" });
    this.patch(workerId, rowId, moved.ok ? { ...rest, resumed: true } : rest);
  }

  private exhausted(workerId: string, rowId: number): { payload: Exhausted } | null {
    const row = this.deps.events.findById(workerId, rowId);
    if (row?.type !== "accounts_exhausted" || !row.payload) return null;
    try {
      return { payload: JSON.parse(row.payload) as Exhausted };
    } catch {
      return null;
    }
  }

  private patch(workerId: string, rowId: number, payload: Exhausted): void {
    this.deps.events.patchPayload(rowId, payload);
    this.deps.bus.publish("worker:change", { workerId, rowId });
  }

  private clear(workerId: string): void {
    const t = this.timers.get(workerId);
    if (!t) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(t.timer);
    this.timers.delete(workerId);
  }
}
