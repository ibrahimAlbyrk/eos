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
import { currentDatetimeDef } from "../defs/current_datetime.ts";
import { listPagesDef } from "../defs/list_pages.ts";
import { readPageDef } from "../defs/read_page.ts";
import { appendToPageDef } from "../defs/append_to_page.ts";
import { setPageTaskDef } from "../defs/set_page_task.ts";

const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "registration.snapshot.json"), "utf8"));

// Browser verbs (Phase 3) — appended to BOTH the orchestrator and worker
// surfaces in this order (registry.ts browserDefs).
// Page tools — on BOTH surfaces, just before the browser verbs (registry.ts pageDefs).
const PAGE_TOOLS = ["list_pages", "read_page", "create_page", "append_to_page", "edit_page", "set_page_task"];
// The user's memory — right after the page tools on both surfaces (registry.ts memoryDefs).
const MEMORY_TOOLS = ["search_memory", "suggest_memory"];

const BROWSER_TOOLS = [
  "browser_navigate", "browser_snapshot", "browser_find", "browser_act",
  "browser_type", "browser_fill_form", "browser_press", "browser_scroll",
  "browser_wait", "browser_get", "browser_screenshot", "browser_tabs",
  "browser_new_tab", "browser_close_tab", "browser_mute", "browser_show",
];

describe("tool registration — byte-identical to the legacy MCP modules", () => {
  it("orchestrator tools register the same names, order, and input schemas", () => {
    const fp = fingerprintModules(orchestratorDefs.map((d) => toMcpModule(d, orchestratorCtx)), FAKE_ORCH_SESSION);
    assert.deepEqual(fp, snapshot.orchestrator);
    assert.deepEqual(Object.keys(fp), [
      "spawn_worker", "list_active_workers", "get_worker", "kill_worker",
      "message_worker", "list_pending_permissions", "notify_user", "ask_user",
      // dynamic_loop TEMPORARILY not registered (loop system disabled) — see registry.ts.
      "list_available_workers", "create_worker", "integrate_workers",
      "current_datetime", "get_worker_messages",
      ...PAGE_TOOLS,
      ...MEMORY_TOOLS,
      ...BROWSER_TOOLS,
    ]);
  });

  it("worker (always-on) tools match", () => {
    const fp = fingerprintModules(workerDefs.map((d) => toMcpModule(d, workerCtx)), FAKE_WORKER_SESSION);
    assert.deepEqual(fp, snapshot.worker);
    assert.deepEqual(Object.keys(fp), ["send_message_to_parent", "current_datetime", ...PAGE_TOOLS, ...MEMORY_TOOLS, ...BROWSER_TOOLS]);
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

  it("page tools call the page routes and answer compactly", async () => {
    const page = {
      id: "pg-abcdef12", title: "Plan", body: "- [ ] a\n", project: "/repo", agentId: null, rev: 2,
      createdAt: 0, updatedAt: 0, updatedBy: { kind: "agent", agentId: "self-1", name: "me" },
    };
    const list = recording({}, { pages: [{ ...page, body: undefined, excerpt: "a", tasks: { open: 1, done: 0 } }] });
    const listed = await listPagesDef.handler(list.ctx, { query: "plan", all: false }) as { pages: Array<Record<string, unknown>> };
    assert.deepEqual(list.calls, [{ method: "GET", path: "/api/pages?q=plan", body: undefined }]);
    assert.equal(listed.pages[0]!.updatedBy, "you");

    const read = recording({}, { page });
    const text = await readPageDef.handler(read.ctx, { id: page.id }) as string;
    assert.ok(text.startsWith("# Plan\n(page pg-abcdef12 · rev 2"));
    assert.ok(text.endsWith("- [ ] a\n"));

    const edit = recording({}, { page });
    assert.deepEqual(await appendToPageDef.handler(edit.ctx, { id: page.id, text: "x", under_heading: "Notes" }), { id: page.id, rev: 2 });
    await setPageTaskDef.handler(edit.ctx, { id: page.id, task: "a", done: true });
    assert.deepEqual(edit.calls.map((c) => c.body), [
      { op: "append", text: "x", heading: "Notes" },
      { op: "setTask", task: "a", done: true },
    ]);
    assert.equal(edit.calls[0]!.path, "/api/pages/pg-abcdef12/edit");
  });

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

  it("ask_peer is asker-keyed, carries the target ref in the body, early-returns when declined", async () => {
    const { ctx, calls } = recording({}, { reason: "busy" }); // no requestId -> no poll loop
    const res = await askPeerDef.handler(ctx, { peerId: "p-2", question: "q" });
    assert.deepEqual(calls, [{ method: "POST", path: "/workers/self-1/peer-request", body: { target: { id: "p-2" }, question: "q" } }]);
    assert.equal(res, "busy");
  });

  it("ask_peer addresses a not-yet-spawned peer by name", async () => {
    const { ctx, calls } = recording({}, { reason: "busy" });
    await askPeerDef.handler(ctx, { peerName: "auth-expert", question: "q" });
    assert.deepEqual(calls[0], { method: "POST", path: "/workers/self-1/peer-request", body: { target: { name: "auth-expert" }, question: "q" } });
  });

  it("ask_peer with neither peerId nor peerName makes no daemon call", async () => {
    const { ctx, calls } = recording();
    const res = await askPeerDef.handler(ctx, { question: "q" });
    assert.equal(calls.length, 0);
    assert.match(res as string, /peerId.*peerName/);
  });

  it("dynamic_loop attach POSTs the request to /orchestrators/:self/loop", async () => {
    const { ctx, calls } = recording();
    const args = { op: "attach", goal: { summary: "g", criteria: [{ id: "c1", text: "t" }] } };
    await dynamicLoopDef.handler(ctx, args);
    assert.deepEqual(calls, [{ method: "POST", path: "/orchestrators/self-1/loop", body: args }]);
  });

  it("dynamic_loop amend POSTs the request to /orchestrators/:self/loop (op-dispatched, not a new route)", async () => {
    const { ctx, calls } = recording();
    const args = { op: "amend", loopId: "l-9", limit: 3 };
    await dynamicLoopDef.handler(ctx, args);
    assert.deepEqual(calls, [{ method: "POST", path: "/orchestrators/self-1/loop", body: args }]);
  });

  it("dynamic_loop stop POSTs the request to /orchestrators/:self/loop/stop", async () => {
    const { ctx, calls } = recording();
    const args = { op: "stop", loopId: "l-9" };
    await dynamicLoopDef.handler(ctx, args);
    assert.deepEqual(calls, [{ method: "POST", path: "/orchestrators/self-1/loop/stop", body: args }]);
  });

  it("current_datetime issues exactly GET /datetime", async () => {
    const { ctx, calls } = recording();
    await currentDatetimeDef.handler(ctx, {});
    assert.deepEqual(calls, [{ method: "GET", path: "/datetime", body: undefined }]);
  });
});
