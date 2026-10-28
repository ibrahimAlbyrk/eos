import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askSideQuestion, type AskSideQuestionDeps } from "../use-cases/AskSideQuestion.ts";
import type { AgentSession, SideAnswer } from "../ports/AgentBackend.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors/index.ts";

function buildDeps(opts: {
  worker?: boolean;
  archived?: boolean;
  session?: boolean;
  sideQuestion?: boolean;
  alive?: boolean;
  revives?: boolean;
  answer?: SideAnswer;
} = {}): { deps: AskSideQuestionDeps; asked: Array<{ question: string; signal?: AbortSignal }>; revived: string[] } {
  const asked: Array<{ question: string; signal?: AbortSignal }> = [];
  const revived: string[] = [];
  let alive = opts.alive ?? true;
  const session = {
    capabilities: { sideQuestion: opts.sideQuestion ?? true },
    isAlive: () => alive,
    askSide: async (question: string, o?: { signal?: AbortSignal }) => {
      asked.push({ question, signal: o?.signal });
      return opts.answer ?? { ok: true, answer: "because" };
    },
  } as unknown as AgentSession;
  const deps: AskSideQuestionDeps = {
    workers: {
      findById: (id: string) => ((opts.worker ?? true) ? ({ id, archived_at: opts.archived ? 1 : null } as never) : null),
    },
    revive: async (w) => {
      revived.push(w.id);
      if (opts.revives ?? true) alive = true;
    },
    session: () => ((opts.session ?? true) ? session : null),
  };
  return { deps, asked, revived };
}

describe("askSideQuestion", () => {
  it("returns the session's answer for the trimmed question", async () => {
    const { deps, asked } = buildDeps();
    const signal = new AbortController().signal;
    const r = await askSideQuestion(deps, { workerId: "w1", question: "  why?  ", signal });
    assert.deepEqual(r, { answer: "because" });
    assert.deepEqual(asked, [{ question: "why?", signal }]);
  });

  it("revives a suspended agent before asking it", async () => {
    const { deps, asked, revived } = buildDeps({ alive: false });
    assert.deepEqual(await askSideQuestion(deps, { workerId: "w1", question: "q" }), { answer: "because" });
    assert.deepEqual(revived, ["w1"]);
    assert.equal(asked.length, 1);
  });

  it("404s an unknown worker", async () => {
    const { deps } = buildDeps({ worker: false });
    await assert.rejects(askSideQuestion(deps, { workerId: "nope", question: "q" }), NotFoundError);
  });

  it("refuses an archived worker without reviving it", async () => {
    const { deps, revived } = buildDeps({ archived: true });
    await assert.rejects(askSideQuestion(deps, { workerId: "w1", question: "q" }), /archived/);
    assert.equal(revived.length, 0);
  });

  it("rejects an empty question without reviving anything", async () => {
    const { deps, asked, revived } = buildDeps();
    await assert.rejects(askSideQuestion(deps, { workerId: "w1", question: "   " }), ValidationError);
    assert.equal(asked.length + revived.length, 0);
  });

  it("refuses a lane that can't answer, without reviving it", async () => {
    for (const opts of [{ sideQuestion: false }, { session: false }]) {
      const { deps, asked, revived } = buildDeps(opts);
      await assert.rejects(askSideQuestion(deps, { workerId: "w1", question: "q" }), /can't answer side questions/);
      assert.equal(asked.length + revived.length, 0);
    }
  });

  it("refuses when the session is still down after reviving", async () => {
    const { deps, asked } = buildDeps({ alive: false, revives: false });
    await assert.rejects(askSideQuestion(deps, { workerId: "w1", question: "q" }), /isn't running/);
    assert.equal(asked.length, 0);
  });

  it("surfaces the session's failure reason as a conflict", async () => {
    const { deps } = buildDeps({ answer: { ok: false, reason: "no answer" } });
    await assert.rejects(
      askSideQuestion(deps, { workerId: "w1", question: "q" }),
      (e: unknown) => e instanceof ConflictError && e.message === "no answer",
    );
  });
});
