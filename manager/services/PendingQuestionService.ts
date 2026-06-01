import type { Clock } from "../../core/src/ports/Clock.ts";
import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";

interface PendingEntry {
  workerId: string;
  toolUseId: string;
  expiresAt: number;
  resolve: (_answers: Record<string, string>) => void;
  reject: (_reason: Error) => void;
}

function keyFor(workerId: string, toolUseId: string): string {
  return `${workerId}\u0000${toolUseId}`;
}

export class PendingQuestionService {
  private pending = new Map<string, PendingEntry>();
  private byKey = new Map<string, string>();
  private clock: Clock;
  private ids: IdGenerator;
  private ttlMs: number;

  constructor(clock: Clock, ids: IdGenerator, ttlMs: number = 3600000) {
    this.clock = clock;
    this.ids = ids;
    this.ttlMs = ttlMs;
  }

  register(workerId: string, toolUseId: string): { questionId: string; promise: Promise<Record<string, string>> } {
    // Only a re-register of the SAME (worker, toolUseId) supersedes the prior
    // one; a different toolUseId (e.g. a concurrent subagent) coexists.
    const key = keyFor(workerId, toolUseId);
    const prior = this.byKey.get(key);
    if (prior) this.reject(prior, new Error("question superseded"));

    const questionId = this.ids.newPendingId();
    const promise = new Promise<Record<string, string>>((resolve, reject) => {
      this.pending.set(questionId, {
        workerId,
        toolUseId,
        expiresAt: this.clock.now() + this.ttlMs,
        resolve,
        reject,
      });
    });
    this.byKey.set(key, questionId);
    return { questionId, promise };
  }

  resolve(questionId: string, answers: Record<string, string>): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    this.pending.delete(questionId);
    this.byKey.delete(keyFor(entry.workerId, entry.toolUseId));
    entry.resolve(answers);
    return true;
  }

  resolveByToolUseId(workerId: string, toolUseId: string, answers: Record<string, string>): boolean {
    const questionId = this.byKey.get(keyFor(workerId, toolUseId));
    if (!questionId) return false;
    return this.resolve(questionId, answers);
  }

  reject(questionId: string, reason: Error): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    this.pending.delete(questionId);
    this.byKey.delete(keyFor(entry.workerId, entry.toolUseId));
    entry.reject(reason);
    return true;
  }

  rejectByWorker(workerId: string, reason: Error): void {
    for (const [questionId, entry] of this.pending) {
      if (entry.workerId === workerId) this.reject(questionId, reason);
    }
  }

  sweepExpired(now: number): void {
    for (const [questionId, entry] of this.pending) {
      if (now > entry.expiresAt) {
        this.pending.delete(questionId);
        this.byKey.delete(keyFor(entry.workerId, entry.toolUseId));
        entry.reject(new Error("question expired"));
      }
    }
  }
}
