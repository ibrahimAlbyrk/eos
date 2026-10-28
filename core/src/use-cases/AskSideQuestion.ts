// AskSideQuestion — the /btw side question: answered from the worker's live
// conversation without adding to it or interrupting a running turn. Gated on
// the session's sideQuestion capability, never on backend kind. Nothing is
// logged or persisted; the answer lives only in the caller's response.

import type { AgentSession } from "../ports/AgentBackend.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors/index.ts";

export interface AskSideQuestionDeps {
  workers: Pick<WorkerRepo, "findById">;
  /** Brings a suspended worker's session back, as a message to it would; a
   *  no-op for a live one. */
  revive(worker: WorkerRow): Promise<void>;
  /** The worker's session in this process, or null when its lane has none. */
  session(workerId: string): AgentSession | null;
}

export interface AskSideQuestionInput {
  workerId: string;
  question: string;
  signal?: AbortSignal;
}

export async function askSideQuestion(
  deps: AskSideQuestionDeps,
  input: AskSideQuestionInput,
): Promise<{ answer: string }> {
  const w = deps.workers.findById(input.workerId);
  if (!w) throw new NotFoundError("worker", input.workerId);
  if (w.archived_at != null) throw new ConflictError("worker is archived — restore first");
  const question = input.question.trim();
  if (!question) throw new ValidationError("question is empty");

  const session = deps.session(w.id);
  if (!session?.capabilities.sideQuestion || !session.askSide) throw new ConflictError("this agent can't answer side questions");
  // Every idle chat is suspended after a daemon restart, so most questions
  // reach an agent with no live session yet.
  await deps.revive(w);
  if (!session.isAlive()) throw new ConflictError("the agent isn't running");

  const r = await session.askSide(question, input.signal ? { signal: input.signal } : undefined);
  if (!r.ok) throw new ConflictError(r.reason);
  return { answer: r.answer };
}
