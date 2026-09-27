import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSdkSummarizer } from "../SdkSummarizer.ts";
import type { SdkQueryFn } from "../ClaudeSdkBackend.ts";

function summarizer(stream: (_p: Parameters<SdkQueryFn>[0]) => AsyncIterable<unknown>, auth = "oauth") {
  const seen: Array<Parameters<SdkQueryFn>[0]> = [];
  const s = createSdkSummarizer({
    authResolver: { resolve: async () => (auth === "oauth" ? { scheme: "oauth", token: "t" } : { scheme: "none" }) as never },
    daemonUrl: "http://x",
    defaultModel: "sonnet",
    cwd: "/repo",
    queryFn: (p) => { seen.push(p); return stream(p) as never; },
  });
  return { s, seen };
}
const input = { system: "SYS", prompt: "PROMPT", model: "opus", timeoutMs: 1000 };

describe("SdkSummarizer", () => {
  it("runs one tool-less, memory-less, unpersisted turn on the given model and returns its text", async () => {
    const { s, seen } = summarizer(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "<summary>" }, { type: "thinking", thinking: "x" }] } };
      yield { type: "assistant", message: { content: [{ type: "text", text: "S</summary>" }] } };
      yield { type: "result", subtype: "success" };
    });
    assert.equal(await s.summarize(input), "<summary>S</summary>");
    const o = seen[0].options as unknown as Record<string, unknown>;
    assert.equal(o.model, "opus");
    assert.equal(o.systemPrompt, "SYS");
    assert.deepEqual(o.tools, []);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.persistSession, false);
    assert.equal(o.maxTurns, 1);
    assert.equal((o.env as Record<string, string>).DISABLE_AUTO_COMPACT, "1");
    const first = await seen[0].prompt[Symbol.asyncIterator]().next();
    assert.deepEqual((first.value as { message: unknown }).message, { role: "user", content: "PROMPT" });
  });

  it("falls back to the default model and rejects an error result", async () => {
    const { s, seen } = summarizer(async function* () { yield { type: "result", subtype: "error_max_turns" }; });
    await assert.rejects(s.summarize({ ...input, model: null }), /error_max_turns/);
    assert.equal((seen[0].options as unknown as Record<string, unknown>).model, "sonnet");
  });

  it("rejects without a subscription credential, and on timeout", async () => {
    await assert.rejects(summarizer(async function* () { yield { type: "result", subtype: "success" }; }, "none").s.summarize(input), /no subscription credential/);
    const { s } = summarizer((p) => (async function* () {
      await new Promise((_r, rej) => (p.options.abortController as AbortController).signal.addEventListener("abort", () => rej(new Error("aborted"))));
      yield { type: "result", subtype: "success" }; // never reached — the abort rejects first
    })());
    await assert.rejects(s.summarize({ ...input, timeoutMs: 10 }), /timed out after 0s/);
  });
});
