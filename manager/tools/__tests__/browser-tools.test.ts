// The browser_* handlers are thin ctx.api() shims onto the /browser/* routes.
// These tests pin the wire: each verb hits its expected route with the exact
// body (tabId resolved but never leaked into the body), and the omitted-tabId
// default resolves to the ACTIVE (foreground) tab via GET /browser/active-tab
// (never the first tab), erroring clearly when there is no active tab.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext, ToolDefinition } from "../types.ts";

import { browserNavigateDef } from "../defs/browser_navigate.ts";
import { browserSnapshotDef } from "../defs/browser_snapshot.ts";
import { browserFindDef } from "../defs/browser_find.ts";
import { browserActDef } from "../defs/browser_act.ts";
import { browserTypeDef } from "../defs/browser_type.ts";
import { browserFillFormDef } from "../defs/browser_fill_form.ts";
import { browserPressDef } from "../defs/browser_press.ts";
import { browserScrollDef } from "../defs/browser_scroll.ts";
import { browserWaitDef } from "../defs/browser_wait.ts";
import { browserGetDef } from "../defs/browser_get.ts";
import { browserScreenshotDef } from "../defs/browser_screenshot.ts";
import { browserTabsDef } from "../defs/browser_tabs.ts";
import { browserNewTabDef } from "../defs/browser_new_tab.ts";
import { browserCloseTabDef } from "../defs/browser_close_tab.ts";
import { browserMuteDef } from "../defs/browser_mute.ts";
import { browserShowDef } from "../defs/browser_show.ts";
import { ROUTES } from "../../../contracts/src/http.ts";

function recording(
  tabs: Array<{ tabId: string }> = [{ tabId: "bt-1" }],
  apiReturn: unknown = { ok: true },
  activeTabId: string | null = tabs[0]?.tabId ?? null,
) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx: ToolContext = {
    selfId: "w-1",
    cwd: "",
    isGitRepo: () => false,
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "GET" && path === "/browser/tabs") return { tabs };
      // resolveTabId's omitted-tabId path. 409 (thrown by daemonApi) when there
      // is no foreground tab — the resolver turns that into a clear error.
      if (method === "GET" && path === "/browser/active-tab") {
        if (!activeTabId) throw new Error('daemon 409: {"error":"no active tab"}');
        return { tabId: activeTabId };
      }
      return apiReturn;
    },
  };
  return { ctx, calls };
}

describe("browser_* handlers — verb → route + body", () => {
  // [def, args, expected last call] with an explicit tabId (no tabs lookup).
  const CASES: Array<[ToolDefinition, Record<string, unknown>, { method: string; path: string; body?: unknown }]> = [
    [browserNavigateDef, { tabId: "bt-9", action: "url", url: "https://example.com" },
      { method: "POST", path: "/browser/tabs/bt-9/navigate", body: { action: "url", url: "https://example.com" } }],
    [browserSnapshotDef, { tabId: "bt-9" },
      { method: "POST", path: "/browser/tabs/bt-9/snapshot", body: { interactiveOnly: true } }],
    [browserFindDef, { tabId: "bt-9", query: "Submit" },
      { method: "POST", path: "/browser/tabs/bt-9/find", body: { query: "Submit" } }],
    [browserActDef, { tabId: "bt-9", ref: "@e1", verb: "click" },
      { method: "POST", path: "/browser/tabs/bt-9/act", body: { ref: "@e1", verb: "click", includeSnapshot: false } }],
    [browserTypeDef, { tabId: "bt-9", ref: "@e2", text: "hi" },
      { method: "POST", path: "/browser/tabs/bt-9/act", body: { ref: "@e2", text: "hi", submit: false, includeSnapshot: false } }],
    [browserFillFormDef, { tabId: "bt-9", fields: [{ ref: "@e2", value: "a" }, { ref: "@e3", value: "b" }] },
      { method: "POST", path: "/browser/tabs/bt-9/act", body: { fields: [{ ref: "@e2", value: "a" }, { ref: "@e3", value: "b" }] } }],
    [browserPressDef, { tabId: "bt-9", key: "Enter" },
      { method: "POST", path: "/browser/tabs/bt-9/act", body: { key: "Enter" } }],
    [browserScrollDef, { tabId: "bt-9", direction: "down" },
      { method: "POST", path: "/browser/tabs/bt-9/act", body: { direction: "down" } }],
    [browserWaitDef, { tabId: "bt-9", forText: "Done" },
      { method: "POST", path: "/browser/tabs/bt-9/wait", body: { forText: "Done", timeoutMs: 15000 } }],
    [browserGetDef, { tabId: "bt-9", what: "url" },
      { method: "POST", path: "/browser/tabs/bt-9/get", body: { what: "url" } }],
    [browserScreenshotDef, { tabId: "bt-9" },
      { method: "POST", path: "/browser/tabs/bt-9/capture", body: { fullPage: false } }],
    [browserCloseTabDef, { tabId: "bt-9" },
      { method: "DELETE", path: "/browser/tabs/bt-9", body: undefined }],
    [browserMuteDef, { tabId: "bt-9", muted: true },
      { method: "POST", path: "/browser/tabs/bt-9/mute", body: { muted: true } }],
  ];

  for (const [def, args, expected] of CASES) {
    it(`${def.name} calls ${expected.method} ${expected.path} and keeps tabId out of the body`, async () => {
      const { ctx, calls } = recording();
      await def.handler(ctx, args);
      assert.deepEqual(calls, [expected]); // exactly one call — explicit tabId skips the tabs lookup
      const body = calls[0].body as Record<string, unknown> | undefined;
      assert.ok(body === undefined || !("tabId" in body), "tabId must not leak into the route body");
    });
  }

  it("browser_tabs lists via GET /browser/tabs", async () => {
    const { ctx, calls } = recording();
    await browserTabsDef.handler(ctx, {});
    assert.deepEqual(calls, [{ method: "GET", path: "/browser/tabs", body: undefined }]);
  });

  it("browser_new_tab POSTs /browser/tabs with the url and returns the daemon result", async () => {
    const { ctx, calls } = recording([], { tabId: "bt-new" });
    const res = await browserNewTabDef.handler(ctx, { url: "https://example.com" });
    assert.deepEqual(calls, [{ method: "POST", path: "/browser/tabs", body: { url: "https://example.com" } }]);
    assert.deepEqual(res, { tabId: "bt-new" });
  });

  it("omitted tabId resolves to the ACTIVE (foreground) tab, not the first — via GET /browser/active-tab", async () => {
    // Two tabs open, the SECOND foregrounded: a tabId-omitted op must hit the
    // second, never tabs[0].
    const { ctx, calls } = recording([{ tabId: "bt-first" }, { tabId: "bt-second" }], { ok: true }, "bt-second");
    await browserActDef.handler(ctx, { ref: "@e1", verb: "click" });
    assert.deepEqual(calls[0], { method: "GET", path: "/browser/active-tab", body: undefined });
    assert.equal(calls[1].path, "/browser/tabs/bt-second/act");
  });

  it("omitted tabId with no active tab fails with a clear 'no active tab' error and makes no act call", async () => {
    const { ctx, calls } = recording([], { ok: true }, null);
    await assert.rejects(() => browserSnapshotDef.handler(ctx, {}), /no active tab/);
    assert.deepEqual(calls, [{ method: "GET", path: "/browser/active-tab", body: undefined }]);
  });

  it("browser_screenshot returns the daemon's { path } verbatim (text-only channel)", async () => {
    const { ctx } = recording([{ tabId: "bt-1" }], { path: "/tmp/eos-paste-x/browser-bt-1.jpeg" });
    const res = await browserScreenshotDef.handler(ctx, {});
    assert.deepEqual(res, { path: "/tmp/eos-paste-x/browser-bt-1.jpeg" });
  });

  it("browser_show POSTs ROUTES.browserShow with the parsed body (tabId kept — the daemon resolves the session)", async () => {
    const { ctx, calls } = recording([{ tabId: "bt-1" }], { ok: true, tabId: "bt-9" });
    const res = await browserShowDef.handler(ctx, { tabId: "bt-9" });
    assert.deepEqual(calls, [{ method: "POST", path: ROUTES.browserShow, body: { tabId: "bt-9" } }]);
    assert.deepEqual(res, { ok: true, tabId: "bt-9" });
  });

  it("browser_show with no tabId POSTs an empty body (present the session's active tab) — no tabs lookup", async () => {
    const { ctx, calls } = recording();
    await browserShowDef.handler(ctx, {});
    assert.deepEqual(calls, [{ method: "POST", path: ROUTES.browserShow, body: {} }]);
  });

  it("browser_navigate rejects an invalid action before any daemon call", async () => {
    const { ctx, calls } = recording();
    await assert.rejects(() => browserNavigateDef.handler(ctx, { action: "teleport" }));
    assert.equal(calls.length, 0);
  });
});
