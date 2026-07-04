import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIModelClient } from "../backends/OpenAIModelClient.ts";
import { createAnthropicModelClient } from "../backends/AnthropicModelClient.ts";
import { withRetry, resolveRetryPolicy } from "../backends/with-retry.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

// MJ3 — a single sustained 429/5xx used to kill a metered turn. withRetry (shared
// inside both clients) retries the retryable statuses with bounded backoff honoring
// Retry-After; only a non-retryable status or exhausted retries becomes
// stopReason:"error". Capability-gated knobs, NOT a per-provider branch.

type Json = Record<string, unknown>;
function res(status: number, bodyObj: Json, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: null,
    async json() { return bodyObj; },
    async text() { return JSON.stringify(bodyObj); },
  } as unknown as Response;
}

const OPENAI_NOSTREAM: ProviderCapabilities = {
  wire: "openai-chat", supportsStreaming: false, supportsTools: true, supportsParallelToolCalls: true,
  reasoning: "none", reasoningRoundTrip: "drop", cache: "automatic", structuredOutput: "none", contextWindow: 8192,
};

describe("model-client retry / backoff (MJ3)", () => {
  it("retries a 429 honoring Retry-After, then succeeds (turn does NOT end)", async () => {
    const sleeps: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) return res(429, { error: "rate limited" }, { "retry-after": "2" });
      return res(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    }) as unknown as typeof fetch;
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: OPENAI_NOSTREAM, fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "end_turn");
    assert.equal(turn.text, "ok");
    assert.equal(call, 2, "retried once");
    assert.deepEqual(sleeps, [2000], "Retry-After (2s) honored");
  });

  it("a non-retryable 400 ends the turn immediately (no retry)", async () => {
    let call = 0;
    const fetchImpl = (async () => { call++; return res(400, { error: "bad request" }); }) as unknown as typeof fetch;
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: OPENAI_NOSTREAM, fetchImpl, sleepImpl: async () => {} });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "error");
    assert.match(turn.error ?? "", /400/);
    assert.equal(call, 1, "no retry on a non-retryable status");
  });

  it("gives up after maxRetries on a sustained 5xx (capability-gated knob)", async () => {
    let call = 0;
    const fetchImpl = (async () => { call++; return res(503, { error: "unavailable" }); }) as unknown as typeof fetch;
    const caps: ProviderCapabilities = { ...OPENAI_NOSTREAM, retry: { maxRetries: 2, baseMs: 1, capMs: 5 } };
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: caps, fetchImpl, sleepImpl: async () => {} });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "error");
    assert.match(turn.error ?? "", /503/);
    assert.equal(call, 3, "initial + 2 retries");
  });

  it("a transient network throw (fetch failed) is retried, then succeeds (turn does NOT end)", async () => {
    const sleeps: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) throw new TypeError("fetch failed");
      return res(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    }) as unknown as typeof fetch;
    const caps: ProviderCapabilities = { ...OPENAI_NOSTREAM, retry: { maxRetries: 4, baseMs: 10, capMs: 50 } };
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: caps, fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "end_turn");
    assert.equal(turn.text, "ok");
    assert.equal(call, 2, "network throw retried once");
    assert.deepEqual(sleeps, [10], "backoff before the retry (no Retry-After header on a throw)");
  });

  it("a sustained network throw is bounded — gives up after maxRetries with the same error shape", async () => {
    let call = 0;
    const errs: unknown[] = [];
    const fetchImpl = (async () => { call++; throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const caps: ProviderCapabilities = { ...OPENAI_NOSTREAM, retry: { maxRetries: 2, baseMs: 1, capMs: 5 } };
    const client = createOpenAIModelClient({ apiKey: "", model: "m", baseUrl: "http://localhost:1", capabilities: caps, fetchImpl, sleepImpl: async () => {}, onProviderError: (e) => errs.push(e) });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "error");
    assert.match(turn.error ?? "", /ECONNREFUSED/);
    assert.equal(call, 3, "initial + 2 retries, then give up");
    assert.deepEqual(errs, [{ transport: "network", detail: "ECONNREFUSED" }], "onProviderError fires once, on the final give-up");
  });

  it("withRetry does NOT retry an aborted turn or an AbortError throw (fail fast)", async () => {
    // A cancelled turn flips signal.aborted — a network throw mid-cancel must not retry.
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new Error("fetch failed"); }, { maxRetries: 4, baseMs: 1, capMs: 5 }, async () => {}, { aborted: true }),
      /fetch failed/,
    );
    assert.equal(calls, 1, "aborted signal → no retry");

    // A real AbortSignal-tied fetch throws an AbortError — also terminal.
    let calls2 = 0;
    await assert.rejects(
      withRetry(async () => { calls2++; const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; }, { maxRetries: 4, baseMs: 1, capMs: 5 }, async () => {}),
      /aborted/,
    );
    assert.equal(calls2, 1, "AbortError → no retry");
  });

  it("Anthropic shares the same wrapper (529 overloaded → retry → success)", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) return res(529, { error: "overloaded" });
      return res(200, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    }) as unknown as typeof fetch;
    const client = createAnthropicModelClient({ apiKey: "k", model: "m", fetchImpl, sleepImpl: async () => {} });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "end_turn");
    assert.equal(call, 2);
  });

  it("withRetry uses safe defaults when no capability knobs are set", () => {
    const p = resolveRetryPolicy(undefined);
    assert.equal(p.maxRetries, 4);
    assert.ok(p.baseMs > 0 && p.capMs >= p.baseMs);
  });

  it("withRetry caps the backoff and stops at maxRetries (deterministic)", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const resp = await withRetry(
      async () => { n++; return res(500, {}); },
      { maxRetries: 3, baseMs: 100, capMs: 250 },
      async (ms) => { sleeps.push(ms); },
    );
    assert.equal(resp.status, 500);
    assert.equal(n, 4, "initial + 3 retries");
    assert.deepEqual(sleeps, [100, 200, 250], "exponential, clamped to capMs");
  });
});
