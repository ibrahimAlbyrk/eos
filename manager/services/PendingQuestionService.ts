import type { Clock } from "../../core/src/ports/Clock.ts";
import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";

interface PendingEntry {
  workerId: string;
  expiresAt: number;
  resolve: (_answers: Record<string, string>) => void;
  reject: (_reason: Error) => void;
}

export class PendingQuestionService {
  private pending = new Map<string, PendingEntry>();
  private byWorker = new Map<string, string>();
  private clock: Clock;
  private ids: IdGenerator;
  private ttlMs: number;

  constructor(clock: Clock, ids: IdGenerator, ttlMs: number = 3600000) {
    this.clock = clock;
    this.ids = ids;
    this.ttlMs = ttlMs;
  }

  register(workerId: string): { questionId: string; promise: Promise<Record<string, string>> } {
    // A second question for the same worker replaces the prior one: reject it
    // so its waiting hook unblocks instead of leaking forever.
    const prior = this.byWorker.get(workerId);
    if (prior) this.reject(prior, new Error("question superseded"));

    const questionId = this.ids.newPendingId();
    const promise = new Promise<Record<string, string>>((resolve, reject) => {
      this.pending.set(questionId, {
        workerId,
        expiresAt: this.clock.now() + this.ttlMs,
        resolve,
        reject,
      });
    });
    this.byWorker.set(workerId, questionId);
    return { questionId, promise };
  }

  resolve(questionId: string, answers: Record<string, string>): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    this.pending.delete(questionId);
    this.byWorker.delete(entry.workerId);
    entry.resolve(answers);
    return true;
  }

  resolveByWorker(workerId: string, answers: Record<string, string>): boolean {
    const questionId = this.byWorker.get(workerId);
    if (!questionId) return false;
    return this.resolve(questionId, answers);
  }

  reject(questionId: string, reason: Error): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    this.pending.delete(questionId);
    this.byWorker.delete(entry.workerId);
    entry.reject(reason);
    return true;
  }

  sweepExpired(now: number): void {
    for (const [questionId, entry] of this.pending) {
      if (now > entry.expiresAt) {
        this.pending.delete(questionId);
        this.byWorker.delete(entry.workerId);
        entry.reject(new Error("question expired"));
      }
    }
  }
}
