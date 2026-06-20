import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { orchestratorDefs, workerDefs, peerDefs } from "../registry.ts";
import { toMcpModule } from "../projections.ts";
import { orchestratorCtx, workerCtx } from "../context.ts";
import { fingerprintModules, FAKE_ORCH_SESSION, FAKE_WORKER_SESSION } from "./fingerprint.ts";
import type { ToolContext } from "../types.ts";

import { notifyUserDef } from "../defs/notify_user.ts";
import { messageWorkerDef } from "../defs/message_worker.ts";
import { spawnWorkerDef } from "../defs/spawn_worker.ts";
import { sendMessageToParentDef } from "../defs/send_message_to_parent.ts";
import { askPeerDef } from "../defs/ask_peer.ts";
import { dynamicLoopDef } from "../defs/dynamic_loop.ts";

const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "registration.snapshot.json"), "utf8"));

describe("tool registration — byte-identical to the legacy MCP modules", () => {
  it("orchestrator tools register the same names, order, and input schemas", () => {
    const fp = fingerprintModules(orchestratorDefs.map((d) => toMcpModule(d, orchestratorCtx)), FAKE_ORCH_SESSION);
    assert.deepEqual(fp, snapshot.orchestrator);
    assert.deepEqual(Object.keys(fp), [
      "spawn_worker", "list_active_workers", "get_worker", "kill_worker",
      "message_worker", "list_pending_permissions", "notify_user", "ask_user",
      "list_available_workers", "create_worker", "integrate_workers", "dynamic_loop",
    ]);
  });

  it("worker (always-on) tools match", () => {
    const fp = fingerprintModules(workerDefs.map((d) => toMcpModule(d, workerCtx)), FAKE_WORKER_SESSION);
    assert.deepEqual(fp, snapshot.worker);
    assert.deepEqual(Object.keys(fp), ["send_message_to_parent"]);
  });

  it("peer (collaborate-only) tools match", () => {
    const fp = fingerprintModules(peerDefs.map((d) => toMcpModule(d, workerCtx)), FAKE_WORKER_SESSION);
    assert.deepEqual(fp, snapshot.peer);
    assert.deepEqual(Object.keys(fp), ["list_peers", "ask_peer", "respond_to_peer"]);
  });
});

describe("tool handlers issue the expected daemon calls", () => {
  function recording(over: Partial<ToolContext> = {}, apiReturn: unknown = {}) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const ctx: ToolContext = {
      selfId: "self-1",
      cwd: "/repo",
      isGitRepo: () => true,
      api: async (method, path, body) => { calls.push({ method, path, body }); return apiReturn; },
      ...over,
    };
    return { ctx, calls };
  }

  it("notify_user POSTs to /workers/:self/notify", async () => {
    const { ctx, calls } = recording();
    await notifyUserDef.handler(ctx, { title: "T", body: "B" });
    assert.deepEqual(calls, [{ method: "POST", path: "/workers/self-1/notify", body: { title: "T", body: "B" } }]);
  });

  it("message_worker addresses the worker id and carries fromParent=self", async () => {
    const { ctx, calls } = recording();
    await messageWorkerDef.handler(ctx, { id: "w-9", text: "go" });
    assert.deepEqual(calls, [{ method: "POST", path: "/workers/w-9/message", body: { text: "go", fromParent: "self-1" } }]);
  });

  it("spawn_worker uses worktreeFrom in a git repo and cwd otherwise", async () => {
    const git = recording();
    await spawnWorkerDef.handler(git.ctx, { prompt: "p" });
    assert.equal(git.calls[0].method, "POST");
    assert.equal(git.calls[0].path, "/workers");
    const gbody = git.calls[0].body as Record<string, unknown>;
    assert.equal(gbody.worktreeFrom, "/repo");
    assert.equal(gbody.cwd, undefined);
    assert.equal(gbody.parentId, "self-1");
    assert.equal(gbody.withGateway, true);

    const nogit = recording({ isGitRepo: () => false });
    await spawnWorkerDef.handler(nogit.ctx, { prompt: "p" });
    const nbody = nogit.calls[0].body as Record<string, unknown>;
    assert.equal(nbody.cwd, "/repo");
    assert.equal(nbody.worktreeFrom, undefined);
  });

  it("send_message_to_parent POSTs the report and returns the fixed confirmation", async () => {
    const { ctx, calls } = recording();
    const res = await sendMessageToParentDef.handler(ctx, { text: "result: done" });
    assert.deepEqual(calls, [{ method: "POST", path: "/workers/self-1/report", body: { text: "result: done" } }]);
    assert.equal(res, "Message delivered to orchestrator.");
  });

  it("ask_peer addresses the peer in the path, carries fromWorker in the body, early-returns when declined", async () => {
    const { ctx, calls } = recording({}, { reason: "busy" }); // no requestId -> no poll loop
    const res = await askPeerDef.handler(ctx, { peerId: "p-2", question: "q" });
    assert.deepEqual(calls, [{ method: "POST", path: "/workers/p-2/peer-request", body: { fromWorker: "self-1", question: "q" } }]);
    assert.equal(res, "busy");
  });

  it("dynamic_loop attach POSTs the request to /orchestrators/:self/loop", async () => {
    const { ctx, calls } = recording();
    const args = { op: "attach", goal: { summary: "g", criteria: [{ id: "c1", text: "t" }] } };
    await dynamicLoopDef.handler(ctx, args);
    assert.deepEqual(calls, [{ method: "POST", path: "/orchestrators/self-1/loop", body: args }]);
  });

  it("dynamic_loop stop POSTs the request to /orchestrators/:self/loop/stop", async () => {
    const { ctx, calls } = recording();
    const args = { op: "stop", loopId: "l-9" };
    await dynamicLoopDef.handler(ctx, args);
    assert.deepEqual(calls, [{ method: "POST", path: "/orchestrators/self-1/loop/stop", body: args }]);
  });
});
