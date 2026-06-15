// In-memory registry for questions the orchestrator's ask_user MCP tool poses
// to the operator. State-based (register → poll), not promise-based: the tool
// polls over short HTTP GETs, so an answer may arrive days later without any
// long-lived socket. A PENDING question has deliberately NO expiry — it waits
// until answered, dismissed, or its worker dies (the no-TTL invariant). Once it
// reaches a TERMINAL state (answered/dismissed) it is kept only for a short
// grace window — long enough that a poll retry after a lost response still sees
// the answer — then pruned, so a persistent orchestrator's settled questions
// can't accumulate across a multi-day session.

import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";

// Comfortably longer than the ask_user poll interval (2.5s) so the asker always
// reads its answer before the entry is reclaimed.
const TERMINAL_GRACE_MS = 5 * 60 * 1000;

export type QuestionState =
  | { status: "pending" }
  | { status: "answered"; answers: Record<string, string> }
  | { status: "dismissed" }
  | { status: "gone" };

interface QuestionEntry {
  workerId: string;
  toolUseId: string;
  state: QuestionState;
  // Set when the entry reaches a terminal state; null while pending. Only
  // terminal entries are eligible for grace-window pruning.
  settledAt: number | null;
}

function keyFor(workerId: string, toolUseId: string): string {
  return `${workerId}\u0000${toolUseId}`;
}

export class PendingQuestionService {
  private entries = new Map<string, QuestionEntry>();
  private byKey = new Map<string, string>();
  private ids: IdGenerator;
  private clock: Clock;

  constructor(ids: IdGenerator, clock: Clock) {
    this.ids = ids;
    this.clock = clock;
  }

  register(workerId: string, toolUseId: string): { questionId: string } {
    this.sweepStaleTerminal();
    // Only a re-register of the SAME (worker, toolUseId) supersedes the prior
    // one; a different toolUseId coexists (concurrent questions).
    const key = keyFor(workerId, toolUseId);
    const prior = this.byKey.get(key);
    if (prior) this.entries.delete(prior);

    const questionId = this.ids.newPendingId();
    this.entries.set(questionId, { workerId, toolUseId, state: { status: "pending" }, settledAt: null });
    this.byKey.set(key, questionId);
    return { questionId };
  }

  poll(questionId: string): QuestionState {
    this.sweepStaleTerminal();
    return this.entries.get(questionId)?.state ?? { status: "gone" };
  }

  resolveByToolUseId(workerId: string, toolUseId: string, answers: Record<string, string>): boolean {
    return this.settle(workerId, toolUseId, { status: "answered", answers });
  }

  dismissByToolUseId(workerId: string, toolUseId: string): boolean {
    return this.settle(workerId, toolUseId, { status: "dismissed" });
  }

  cancelByWorker(workerId: string): void {
    for (const [questionId, entry] of this.entries) {
      if (entry.workerId !== workerId) continue;
      this.entries.delete(questionId);
      this.byKey.delete(keyFor(entry.workerId, entry.toolUseId));
    }
  }

  private settle(workerId: string, toolUseId: string, state: QuestionState): boolean {
    const questionId = this.byKey.get(keyFor(workerId, toolUseId));
    const entry = questionId ? this.entries.get(questionId) : undefined;
    if (!entry || entry.state.status !== "pending") return false;
    entry.state = state;
    entry.settledAt = this.clock.now();
    return true;
  }

  // Reclaim terminal (answered/dismissed) entries older than the grace window.
  // Pending entries (settledAt === null) are NEVER touched — a question may
  // legitimately wait days for an answer.
  private sweepStaleTerminal(): void {
    const cutoff = this.clock.now() - TERMINAL_GRACE_MS;
    for (const [questionId, entry] of this.entries) {
      if (entry.settledAt !== null && entry.settledAt < cutoff) {
        this.entries.delete(questionId);
        this.byKey.delete(keyFor(entry.workerId, entry.toolUseId));
      }
    }
  }
}
