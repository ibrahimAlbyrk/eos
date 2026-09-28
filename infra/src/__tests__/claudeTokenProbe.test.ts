import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeClaudeToken } from "../auth/claudeTokenProbe.ts";

const respond = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

describe("probeClaudeToken", () => {
  it("valid on 2xx", async () => {
    assert.equal(await probeClaudeToken("t", respond(200)), "valid");
  });

  it("rejected only on 401", async () => {
    assert.equal(await probeClaudeToken("t", respond(401)), "rejected");
  });

  it("unknown on any other failure, so a flaky upstream never reads as expired", async () => {
    assert.equal(await probeClaudeToken("t", respond(429)), "unknown");
    assert.equal(await probeClaudeToken("t", respond(503)), "unknown");
    const offline = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    assert.equal(await probeClaudeToken("t", offline), "unknown");
  });

  it("sends the token as a bearer header", async () => {
    let auth: string | null = null;
    const capture = (async (_url: string, init: Parameters<typeof fetch>[1]) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await probeClaudeToken("sk-ant-oat01-x", capture);
    assert.equal(auth, "Bearer sk-ant-oat01-x");
  });
});
