// In-memory registry for questions the orchestrator's ask_user MCP tool poses
// to the operator. State-based (register → poll), not promise-based: the tool
// polls over short HTTP GETs, so an answer may arrive days later without any
// long-lived socket. There is deliberately NO expiry — a question waits until
// it is answered, dismissed, or its worker dies. Entries are tiny and
// human-scale, so terminal states are kept (a poll retry after a lost response
// must still see the answer) until cancelByWorker or daemon restart clears them.

import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";

export type QuestionState =
  | { status: "pending" }
  | { status: "answered"; answers: Record<string, string> }
  | { status: "dismissed" }
  | { status: "gone" };

interface QuestionEntry {
  workerId: string;
  toolUseId: string;
  state: QuestionState;
}

function keyFor(workerId: string, toolUseId: string): string {
  return `${workerId}\u0000${toolUseId}`;
}

export class PendingQuestionService {
  private entries = new Map<string, QuestionEntry>();
  private byKey = new Map<string, string>();
  private ids: IdGenerator;

  constructor(ids: IdGenerator) {
    this.ids = ids;
  }

  register(workerId: string, toolUseId: string): { questionId: string } {
    // Only a re-register of the SAME (worker, toolUseId) supersedes the prior
    // one; a different toolUseId coexists (concurrent questions).
    const key = keyFor(workerId, toolUseId);
    const prior = this.byKey.get(key);
    if (prior) this.entries.delete(prior);

    const questionId = this.ids.newPendingId();
    this.entries.set(questionId, { workerId, toolUseId, state: { status: "pending" } });
    this.byKey.set(key, questionId);
    return { questionId };
  }

  poll(questionId: string): QuestionState {
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
    return true;
  }
}
