// AskSideQuestion — the /btw side question: answered from the worker's live
// conversation without adding to it or interrupting a running turn. Gated on
// the session's sideQuestion capability, never on backend kind. Nothing is
// logged or persisted; the answer lives only in the caller's response.

import type { AgentSession } from "../ports/AgentBackend.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors/index.ts";

export interface AskSideQuestionDeps {
  workers: Pick<WorkerRepo, "findById">;
  /** The worker's live session, or null when it has none in this process. */
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
  if (!deps.workers.findById(input.workerId)) throw new NotFoundError("worker", input.workerId);
  const question = input.question.trim();
  if (!question) throw new ValidationError("question is empty");

  const session = deps.session(input.workerId);
  if (session && !session.capabilities.sideQuestion) throw new ConflictError("this agent can't answer side questions");
  if (!session?.askSide || !session.isAlive()) throw new ConflictError("the agent isn't running");

  const r = await session.askSide(question, input.signal ? { signal: input.signal } : undefined);
  if (!r.ok) throw new ConflictError(r.reason);
  return { answer: r.answer };
}
