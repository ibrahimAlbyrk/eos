import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askSideQuestion, type AskSideQuestionDeps } from "../use-cases/AskSideQuestion.ts";
import type { AgentSession, SideAnswer } from "../ports/AgentBackend.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors/index.ts";

function buildDeps(opts: {
  worker?: boolean;
  session?: boolean;
  sideQuestion?: boolean;
  alive?: boolean;
  answer?: SideAnswer;
} = {}): { deps: AskSideQuestionDeps; asked: Array<{ question: string; signal?: AbortSignal }> } {
  const asked: Array<{ question: string; signal?: AbortSignal }> = [];
  const session = {
    capabilities: { sideQuestion: opts.sideQuestion ?? true },
    isAlive: () => opts.alive ?? true,
    askSide: async (question: string, o?: { signal?: AbortSignal }) => {
      asked.push({ question, signal: o?.signal });
      return opts.answer ?? { ok: true, answer: "because" };
    },
  } as unknown as AgentSession;
  const deps: AskSideQuestionDeps = {
    workers: { findById: (id: string) => ((opts.worker ?? true) ? ({ id } as never) : null) },
    session: () => ((opts.session ?? true) ? session : null),
  };
  return { deps, asked };
}

describe("askSideQuestion", () => {
  it("returns the session's answer for the trimmed question", async () => {
    const { deps, asked } = buildDeps();
    const signal = new AbortController().signal;
    const r = await askSideQuestion(deps, { workerId: "w1", question: "  why?  ", signal });
    assert.deepEqual(r, { answer: "because" });
    assert.deepEqual(asked, [{ question: "why?", signal }]);
  });

  it("404s an unknown worker", async () => {
    const { deps } = buildDeps({ worker: false });
    await assert.rejects(askSideQuestion(deps, { workerId: "nope", question: "q" }), NotFoundError);
  });

  it("rejects an empty question", async () => {
    const { deps, asked } = buildDeps();
    await assert.rejects(askSideQuestion(deps, { workerId: "w1", question: "   " }), ValidationError);
    assert.equal(asked.length, 0);
  });

  it("refuses a session without the capability", async () => {
    const { deps, asked } = buildDeps({ sideQuestion: false });
    await assert.rejects(askSideQuestion(deps, { workerId: "w1", question: "q" }), /can't answer side questions/);
    assert.equal(asked.length, 0);
  });

  it("refuses when the agent has no live session", async () => {
    for (const opts of [{ session: false }, { alive: false }]) {
      const { deps, asked } = buildDeps(opts);
      await assert.rejects(askSideQuestion(deps, { workerId: "w1", question: "q" }), /isn't running/);
      assert.equal(asked.length, 0);
    }
  });

  it("surfaces the session's failure reason as a conflict", async () => {
    const { deps } = buildDeps({ answer: { ok: false, reason: "no answer" } });
    await assert.rejects(
      askSideQuestion(deps, { workerId: "w1", question: "q" }),
      (e: unknown) => e instanceof ConflictError && e.message === "no answer",
    );
  });
});
