// MJ1 / Q0b — baseUrl is origin-only; the client owns the version path. These
// assert the EXACT composed URL for the three configured-baseUrl forms (origin,
// origin+trailing-slash, origin+"/v1") so a user-supplied ".../v1" never
// double-joins to "/v1/v1/...".

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIModelClient } from "../backends/OpenAIModelClient.ts";
import { createAnthropicModelClient } from "../backends/AnthropicModelClient.ts";
import { normalizeBaseOrigin, modelsPathFor } from "../backends/base-url.ts";
import type { ModelMessage } from "../../../core/src/ports/ModelClient.ts";

const messages: ModelMessage[] = [{ role: "user", content: "hi" }];

function captureFetch(json: unknown): { cap: { url?: string }; fetchImpl: typeof fetch } {
  const cap: { url?: string } = {};
  const fetchImpl = (async (url: string) => {
    cap.url = url;
    return { ok: true, async json() { return json; } } as unknown as Response;
  }) as unknown as typeof fetch;
  return { cap, fetchImpl };
}

describe("baseUrl origin-only composition (MJ1/Q0b)", () => {
  it("normalizeBaseOrigin strips a trailing slash and a trailing /v1", () => {
    assert.equal(normalizeBaseOrigin("http://localhost:11434"), "http://localhost:11434");
    assert.equal(normalizeBaseOrigin("http://localhost:11434/"), "http://localhost:11434");
    assert.equal(normalizeBaseOrigin("http://localhost:11434/v1"), "http://localhost:11434");
    assert.equal(normalizeBaseOrigin("http://localhost:11434/v1/"), "http://localhost:11434");
  });

  it("modelsPathFor swaps /chat/completions → /models, else defaults to /v1/models", () => {
    assert.equal(modelsPathFor(undefined), "/v1/models");
    assert.equal(modelsPathFor("/v1/chat/completions"), "/v1/models");
    assert.equal(modelsPathFor("/api/paas/v4/chat/completions"), "/api/paas/v4/models"); // Zhipu
    assert.equal(modelsPathFor("/chat/completions"), "/models"); // Gemini shim
  });

  for (const input of ["http://localhost:11434", "http://localhost:11434/", "http://localhost:11434/v1"]) {
    it(`OpenAI: ${input} → http://localhost:11434/v1/chat/completions`, async () => {
      const { cap, fetchImpl } = captureFetch({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      const client = createOpenAIModelClient({ apiKey: "k", model: "m", baseUrl: input, fetchImpl });
      await client.createTurn(messages);
      assert.equal(cap.url, "http://localhost:11434/v1/chat/completions");
    });

    it(`Anthropic: ${input} → http://localhost:11434/v1/messages`, async () => {
      const { cap, fetchImpl } = captureFetch({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
      const client = createAnthropicModelClient({ apiKey: "k", model: "m", baseUrl: input, fetchImpl });
      await client.createTurn(messages);
      assert.equal(cap.url, "http://localhost:11434/v1/messages");
    });
  }
});
