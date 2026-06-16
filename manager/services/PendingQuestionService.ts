// In-memory registry for questions the orchestrator's ask_user MCP tool poses
// to the operator. State-based (register → poll), not promise-based: the tool
// polls over short HTTP GETs, so an answer may arrive days later without any
// long-lived socket. A PENDING question has deliberately NO expiry — it waits
// until answered, dismissed, or its worker dies. Once it reaches a TERMINAL
// state it is kept only for a short grace window then pruned. That whole
// lifecycle (no-TTL pending, terminal grace, first-settle-wins) lives in the
// shared PendingStore; this service adds only the question-specific shape and
// the supersede-by-(worker, toolUseId) rule.

import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import { PendingStore, type PendingEntry } from "./PendingStore.ts";

export type QuestionState =
  | { status: "pending" }
  | { status: "answered"; answers: Record<string, string> }
  | { status: "dismissed" }
  | { status: "gone" };

interface QuestionMeta {
  workerId: string;
  toolUseId: string;
}

export class PendingQuestionService {
  private store: PendingStore<QuestionState, QuestionMeta>;
  private ids: IdGenerator;

  constructor(ids: IdGenerator, clock: Clock) {
    this.ids = ids;
    this.store = new PendingStore<QuestionState, QuestionMeta>(clock);
  }

  register(workerId: string, toolUseId: string): { questionId: string } {
    this.store.sweep();
    // Only a re-register of the SAME (worker, toolUseId) supersedes the prior
    // one; a different toolUseId coexists (concurrent questions). Every register
    // supersedes, so there is at most one entry per pair to find.
    const prior = this.find(workerId, toolUseId);
    if (prior) this.store.delete(prior.id);

    const questionId = this.ids.newPendingId();
    this.store.add(questionId, { status: "pending" }, { workerId, toolUseId });
    return { questionId };
  }

  poll(questionId: string): QuestionState {
    this.store.sweep();
    return this.store.get(questionId)?.state ?? { status: "gone" };
  }

  resolveByToolUseId(workerId: string, toolUseId: string, answers: Record<string, string>): boolean {
    const e = this.find(workerId, toolUseId);
    return e ? this.store.settle(e.id, { status: "answered", answers }) : false;
  }

  dismissByToolUseId(workerId: string, toolUseId: string): boolean {
    const e = this.find(workerId, toolUseId);
    return e ? this.store.settle(e.id, { status: "dismissed" }) : false;
  }

  cancelByWorker(workerId: string): void {
    for (const e of [...this.store.all()]) {
      if (e.meta.workerId === workerId) this.store.delete(e.id);
    }
  }

  private find(workerId: string, toolUseId: string): PendingEntry<QuestionState, QuestionMeta> | undefined {
    for (const e of this.store.all()) {
      if (e.meta.workerId === workerId && e.meta.toolUseId === toolUseId) return e;
    }
    return undefined;
  }
}
