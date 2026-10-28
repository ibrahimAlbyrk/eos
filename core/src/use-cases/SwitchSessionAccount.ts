// SwitchSessionAccount — a session's plan sign-in became unusable mid-turn: it
// hit its plan limit (lifted at resetsAt) or stopped working (out until it is
// signed in again). Either way the ledger sets it aside, so new sessions skip it.
//
//   switched  — auto-switch is on and another sign-in is ready: the session moves
//               to the one with the most room left (same conversation),
//               account_switched is recorded, and a continuation prompt (never
//               shown) picks the turn back up.
//   exhausted — no other sign-in is ready: accounts_exhausted is recorded (the
//               row offers to resume at the next reset, or on the API key) and
//               the user is told on macOS.
//   kept      — anything else: the turn ends as it did.
//
// moveSession is the one way a session changes credential — here, on the API key
// (ContinueOnApiKey) and when a limit lifts (PlanResumeService).

import type { AgentBackendRegistry, AgentSession, SessionCredential } from "../ports/AgentBackend.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { Logger } from "../ports/Logger.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { PlanLoginRecord } from "../domain/plan-logins.ts";
import type { PlanLoginReader } from "../services/PlanLoginService.ts";
import type { PlanLimitLedger, PlanLimitReason } from "../services/PlanLimitLedger.ts";

export type PlanOutcome = "switched" | "exhausted" | "kept";

export interface MoveSessionDeps {
  workers: Pick<WorkerRepo, "findById">;
  events: Pick<EventRepo, "append">;
  bus: Pick<EventBus, "publish">;
  clock: Clock;
  backends: AgentBackendRegistry;
  /** The prompt that picks the interrupted turn back up. */
  continuation(): string;
  log: Logger;
}

export interface SwitchSessionAccountDeps extends MoveSessionDeps {
  logins: PlanLoginReader;
  ledger: PlanLimitLedger;
  /** The sign-in still has a credential in its store. */
  signedIn(login: PlanLoginRecord): boolean;
  /** An API key is set for the provider — the exhausted row can offer it. */
  apiKeySet(): boolean;
  /** How much of its 5-hour window a sign-in has used (0–100), if known. */
  used?(login: PlanLoginRecord): number | undefined;
}

export interface SwitchSessionAccountInput {
  workerId: string;
  provider: string;
  /** The credential store the session ran on. */
  storeDir: string;
  reason: PlanLimitReason;
  /** When the limit lifts (epoch ms), if the provider said. */
  resetsAt?: number;
}

// account_switched payload: what the divider says. from/to are labels at the
// time; reason limit | expired | reset (a limit lifted) | api_key (the user's call).
export interface AccountSwitchedRow {
  provider: string;
  from?: string;
  to: string;
  reason: PlanLimitReason | "reset" | "api_key";
  resetsAt?: string;
}

const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function liveSwitchable(deps: MoveSessionDeps, workerId: string): AgentSession | null {
  const w = deps.workers.findById(workerId);
  const kind = w?.backend_kind ?? "claude";
  if (!w || !deps.backends.has(kind)) return null;
  const session = deps.backends.get(kind).attach(workerId, { kind: "inproc", ref: workerId });
  return session.capabilities.accountSwitch && session.switchAccount && session.isAlive() ? session : null;
}

export async function moveSession(
  deps: MoveSessionDeps,
  workerId: string,
  credential: SessionCredential,
  row: AccountSwitchedRow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = liveSwitchable(deps, workerId);
  if (!session) return { ok: false, error: "this agent can't change account right now" };
  const switched = await session.switchAccount!(credential);
  if (!switched.ok) {
    deps.log.warn("account switch failed", { workerId, to: row.to, error: switched.reason });
    return { ok: false, error: switched.reason ?? "the session could not restart" };
  }
  const rowId = deps.events.append(workerId, deps.clock.now(), "account_switched", row);
  deps.bus.publish("worker:change", { workerId, rowId });
  await session.sendMessage(deps.continuation());
  deps.log.info("session moved to another credential", { workerId, to: row.to, reason: row.reason });
  return { ok: true };
}

// The earliest a limited sign-in comes back; none when every one is out.
function nextReset(deps: SwitchSessionAccountDeps, provider: string): number | undefined {
  const until = deps.logins.list(provider)
    .filter((l) => deps.signedIn(l))
    .map((l) => deps.ledger.blocked(l.id))
    .flatMap((m) => (m?.reason === "limit" && m.until ? [m.until] : []));
  return until.length ? Math.min(...until) : undefined;
}

function recordExhausted(deps: SwitchSessionAccountDeps, workerId: string, provider: string): void {
  const next = nextReset(deps, provider);
  const rowId = deps.events.append(workerId, deps.clock.now(), "accounts_exhausted", {
    provider,
    ...(next ? { nextResetAt: new Date(next).toISOString() } : {}),
    apiKey: deps.apiKeySet(),
  });
  deps.bus.publish("worker:change", { workerId, rowId });
  const name = deps.workers.findById(workerId)?.name ?? "An agent";
  deps.bus.publish("notification:fire", {
    title: "Claude accounts are out",
    body: next ? `${name} stopped — the next limit resets at ${clockTime(next)}.` : `${name} stopped — sign in again to continue.`,
    workerId,
    ts: deps.clock.now(),
  });
}

export async function switchSessionAccount(deps: SwitchSessionAccountDeps, input: SwitchSessionAccountInput): Promise<PlanOutcome> {
  const { workerId, provider, reason } = input;
  const from = deps.logins.list(provider).find((l) => l.storeDir === input.storeDir);
  if (!from) return "kept";
  deps.ledger.mark(from.id, reason, input.resetsAt);

  const to = deps.logins.switchTarget(
    provider,
    (l) => l.id !== from.id && deps.ledger.readiness(l.id, deps.signedIn(l)) === "ready",
    (l) => deps.used?.(l),
  );
  if (!to) {
    recordExhausted(deps, workerId, provider);
    return "exhausted";
  }
  if (!deps.logins.autoSwitch(provider)) return "kept";
  const moved = await moveSession(deps, workerId, { storeDir: to.storeDir }, {
    provider,
    from: from.label,
    to: to.label,
    reason,
    ...(reason === "limit" && input.resetsAt ? { resetsAt: new Date(input.resetsAt).toISOString() } : {}),
  });
  return moved.ok ? "switched" : "kept";
}
