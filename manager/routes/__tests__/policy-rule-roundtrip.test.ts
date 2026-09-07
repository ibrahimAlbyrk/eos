// Round-trip guard for the "always allow" flow: the shape written by
// POST /api/policy/rule must be the shape the engine reads back and honors.
// Regression — the route used to write { match, behavior } while the loader
// compiles { tool, action }, so every saved rule was dropped and the tool
// re-asked forever. This drives the REAL handler → disk → real loader → real
// engine and asserts the decision is `allow`, not `ask`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../Router.ts";
import { registerPolicyRoutes } from "../policy.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import { loadPolicy } from "../../../infra/src/policy/YamlPolicyLoader.ts";
import { evaluatePolicy } from "../../../core/src/domain/policy.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

const noopLog: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return noopLog; },
};

function fakeContainer(home: string) {
  let reloads = 0;
  const c = {
    config: { daemon: { home } },
    reloadPolicy: () => { reloads++; },
  } as unknown as Container;
  return { c, reloads: () => reloads };
}

async function post(c: Container, path: string, body: unknown) {
  const router = new Router();
  registerPolicyRoutes(router, c);
  const m = router.match("POST", path);
  assert.ok(m, `no POST route matched ${path}`);
  const req = Readable.from([JSON.stringify(body)]) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, req, res } as RouteContext);
  return { status, payload };
}

function readbackDecision(home: string, tool: string) {
  const policy = loadPolicy({
    candidates: [join(home, "policy.yaml")],
    defaultTtlMs: 30000,
    log: noopLog,
  });
  return evaluatePolicy(policy, tool, {}).behavior;
}

describe("POST /api/policy/rule round-trips into the engine", () => {
  it("a saved allow rule is honored as `allow` on reload (was `ask` before fix)", async () => {
    const home = mkdtempSync(join(tmpdir(), "eos-policy-"));
    const { c, reloads } = fakeContainer(home);
    try {
      const tool = "mcp__demo__do";
      // Fresh policy.yaml defaults to `ask`, so an `allow` decision here can
      // ONLY come from the written rule matching — the exact bug we fixed.
      const out = await post(c, "/api/policy/rule", { tool, behavior: "allow" });
      assert.equal(out.status, 200);
      assert.deepEqual(out.payload, { ok: true });
      assert.equal(reloads(), 1);
      assert.equal(readbackDecision(home, tool), "allow");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("dedups on tool — a second identical write reports existed", async () => {
    const home = mkdtempSync(join(tmpdir(), "eos-policy-"));
    const { c } = fakeContainer(home);
    try {
      await post(c, "/api/policy/rule", { tool: "Foo", behavior: "allow" });
      const second = await post(c, "/api/policy/rule", { tool: "Foo", behavior: "allow" });
      assert.deepEqual(second.payload, { ok: true, existed: true });
      assert.equal(readbackDecision(home, "Foo"), "allow");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an invalid behavior with 400", async () => {
    const home = mkdtempSync(join(tmpdir(), "eos-policy-"));
    const { c } = fakeContainer(home);
    try {
      const out = await post(c, "/api/policy/rule", { tool: "Bar", behavior: "sometimes" });
      assert.equal(out.status, 400);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
