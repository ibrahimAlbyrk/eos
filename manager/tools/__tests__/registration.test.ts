import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { orchestratorDefs, workerDefs, peerDefs, focusedDefs } from "../registry.ts";
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
import { sendToMachineDef } from "../defs/send_to_machine.ts";
import { presentDef } from "../defs/present.ts";
import { presentAppDef } from "../defs/present_app.ts";
import { GENUI_OFF_TEXT } from "../../../contracts/src/genui/spec.ts";
import { GENUI_APPS_OFF_TEXT } from "../../../core/src/use-cases/PresentView.ts";

const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "registration.snapshot.json"), "utf8"));

// Browser verbs (Phase 3) — appended to BOTH the orchestrator and worker
// surfaces in this order (registry.ts browserDefs).
// Page tools — on BOTH surfaces, just before the browser verbs (registry.ts pageDefs).
const PAGE_TOOLS = ["list_pages", "read_page", "create_page", "append_to_page", "edit_page", "set_page_task"];
// The user's memory — right after the page tools on both surfaces (registry.ts memoryDefs).
const MEMORY_TOOLS = ["search_memory", "suggest_memory"];

// Visual answers — last on the orchestrator surface, after send_to_machine on the
// focused one (registry.ts genuiDefs); never on a worker.
const GENUI_TOOLS = ["present", "present_app", "find_places", "current_location"];

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
      ...GENUI_TOOLS,
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

  it("focused-only tools match, and no other surface has them", () => {
    const fp = fingerprintModules(focusedDefs.map((d) => toMcpModule(d, workerCtx)), FAKE_WORKER_SESSION);
    assert.deepEqual(fp, snapshot.focused);
    assert.deepEqual(Object.keys(fp), ["send_to_machine", ...GENUI_TOOLS]);
    for (const defs of [orchestratorDefs, workerDefs, peerDefs]) assert.equal(defs.some((d) => d.name === "send_to_machine"), false);
  });

  it("visual answers reach orchestrators and focused sessions only — never a worker", () => {
    for (const name of GENUI_TOOLS) {
      assert.ok(orchestratorDefs.some((d) => d.name === name), `orchestrator has ${name}`);
      assert.ok(focusedDefs.some((d) => d.name === name), `focused has ${name}`);
      for (const defs of [workerDefs, peerDefs]) assert.equal(defs.some((d) => d.name === name), false, `no worker gets ${name}`);
    }
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

  it("send_to_machine starts the transfer as itself, follows it, and says where it landed", async () => {
    const done = {
      id: "tr-0000aaaa", status: "done", roots: [{ name: "web.zip" }], sources: ["/repo/builds/web.zip"], totalBytes: 41_200_000,
      doneBytes: 41_200_000, placed: [{ name: "web.zip", path: "/Users/me/Downloads/Eos/web.zip" }], error: null,
    };
    const { ctx, calls } = recording({}, done);
    const text = await sendToMachineDef.handler(ctx, { machine: "MacBook Air", paths: ["builds/web.zip"] }) as string;
    assert.deepEqual(calls, [{ method: "POST", path: "/workers/self-1/transfers", body: { machine: "MacBook Air", paths: ["builds/web.zip"] } }]);
    assert.equal(text, "Sent web.zip (39 MB) to MacBook Air: /Users/me/Downloads/Eos/web.zip (tr-0000aaaa)");
  });

  it("send_to_machine passes on the daemon's reason, not its raw reply", async () => {
    const { ctx } = recording({ api: async () => { throw new Error('daemon 400: {"error":"invalid request: No paired Mac matches \\"iMac\\". Paired Macs: Office (online)."}'); } });
    await assert.rejects(sendToMachineDef.handler(ctx, { machine: "iMac", paths: ["a"] }), /^Error: No paired Mac matches "iMac"\. Paired Macs: Office \(online\)\.$/);
  });

  it("present posts the call's input as itself and answers in one line", async () => {
    const stats = {
      uiBytes: 900, dataBytes: 2000, elements: 7, depth: 2, components: ["Map", "Table"],
      collections: [{ name: "places", count: 6, type: "Place" }, { name: "sources", count: 4, type: null }],
      images: 0, sites: 3, maps: 1, primaryActions: 1,
    };
    const { ctx, calls } = recording({}, { viewId: "v_AbCdEfGh1234", warnings: [], stats });
    const input = { title: "Kadıköy tonight", ui: '<Map of="places"/>', summary: "6 places", data: { places: [] } };
    const text = await presentDef.handler(ctx, input) as string;
    assert.deepEqual(calls, [{ method: "POST", path: "/api/genui/views", body: { input } }]);
    assert.equal(text, "view v_AbCdEfGh1234 rendered · 6 places");

    const warned = recording({}, { viewId: "v_AbCdEfGh1234", warnings: [{ path: "data.places[2].site", message: "is not a domain" }], stats });
    assert.equal(
      await presentDef.handler(warned.ctx, input),
      "view v_AbCdEfGh1234 rendered · 6 places\nwarnings (fix next time, no need to re-present):\n· data.places[2].site: is not a domain",
    );
  });

  it("a rejected present shows the model only the problems, never the HTTP reply", async () => {
    const body = {
      error: "2 problems — nothing rendered\n· data.places[3].rating: 6.2 is outside 0–5\n· ui line 4 <Carousel of=\"places\">: 11 items, max 8\nfix and call present again",
      problems: [
        { path: "data.places[3].rating", message: "6.2 is outside 0–5" },
        { path: 'ui line 4 <Carousel of="places">', message: "11 items, max 8" },
      ],
    };
    const { ctx } = recording({ api: async () => { throw new Error(`daemon 400: ${JSON.stringify(body)}`); } });
    await assert.rejects(presentDef.handler(ctx, { title: "x", ui: "x", summary: "x" }), (e: Error) => {
      assert.equal(e.message, [
        "present: 2 problems — nothing rendered",
        "· data.places[3].rating: 6.2 is outside 0–5",
        '· ui line 4 <Carousel of="places">: 11 items, max 8',
        "fix and call present again",
      ].join("\n"));
      return true;
    });
  });

  it("present answers in text when the user turned visual answers off; other refusals stay errors", async () => {
    const off = recording({ api: async () => { throw new Error(`daemon 403: ${JSON.stringify({ error: GENUI_OFF_TEXT })}`); } });
    assert.equal(await presentDef.handler(off.ctx, { title: "x", ui: "x", summary: "x" }), GENUI_OFF_TEXT);
    const worker = recording({ api: async () => { throw new Error('daemon 403: {"error":"only an orchestrator or a focused session can present"}'); } });
    await assert.rejects(presentDef.handler(worker.ctx, { title: "x", ui: "x", summary: "x" }), /^Error: only an orchestrator or a focused session can present$/);
    const down = recording({ api: async () => { throw new Error('daemon 500: {"error":"database is locked"}'); } });
    await assert.rejects(presentDef.handler(down.ctx, { title: "x", ui: "x", summary: "x" }), /^Error: database is locked$/);
  });

  it("present_app posts to the apps route; problems and a switched-off answer read like present's", async () => {
    const ok = recording({}, { viewId: "v_AbCdEfGh1234", warnings: [] });
    const input = { title: "Brew timer", html: "<html><body>…</body></html>", summary: "A timer", height: 460 };
    assert.equal(await presentAppDef.handler(ok.ctx, input), "view v_AbCdEfGh1234 rendered · app");
    assert.deepEqual(ok.calls, [{ method: "POST", path: "/api/genui/apps", body: { input } }]);

    const bad = recording({ api: async () => { throw new Error(`daemon 400: ${JSON.stringify({ error: "…", problems: [{ path: "html", message: "is 300 KB, max 256 KB — inline less" }] })}`); } });
    await assert.rejects(presentAppDef.handler(bad.ctx, input), (e: Error) => {
      assert.equal(e.message, "present_app: 1 problem — nothing rendered\n· html: is 300 KB, max 256 KB — inline less\nfix and call present_app again");
      return true;
    });

    const off = recording({ api: async () => { throw new Error(`daemon 403: ${JSON.stringify({ error: GENUI_APPS_OFF_TEXT })}`); } });
    assert.equal(await presentAppDef.handler(off.ctx, input), GENUI_APPS_OFF_TEXT);
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
