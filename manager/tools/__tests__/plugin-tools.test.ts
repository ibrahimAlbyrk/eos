import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pluginStatusDef } from "../defs/plugin_status.ts";
import type { ToolContext } from "../types.ts";

function ctxReturning(reply: (path: string) => unknown) {
  const calls: string[] = [];
  const ctx: ToolContext = {
    selfId: "w1",
    cwd: "/repo",
    isGitRepo: () => false,
    api: async (_method, path) => { calls.push(path); return reply(path); },
  };
  return { ctx, calls };
}

const info = (over: Record<string, unknown> = {}) => ({
  id: "clock", dir: "/h/plugins/clock", manifest: { id: "clock", name: "Clock" }, enabled: true, state: "active",
  error: null, rev: 3, hasUi: true, hasCss: false, settings: { seconds: false }, ...over,
});

describe("plugin_status", () => {
  it("with no id lists the plugins and where they live", async () => {
    const { ctx, calls } = ctxReturning(() => ({ plugins: [info()], dir: "/h/plugins" }));
    const out = await pluginStatusDef.handler(ctx, {});
    assert.deepEqual(calls, ["/api/plugins"]);
    assert.deepEqual(out, { pluginsDir: "/h/plugins", plugins: [{ id: "clock", name: "Clock", state: "active", error: null }] });
  });

  it("with an id waits for the rebuild and says whether the window loaded it", async () => {
    const { ctx, calls } = ctxReturning(() => ({ plugin: info(), report: { rev: 3, ok: true, at: 1 } }));
    const out = (await pluginStatusDef.handler(ctx, { id: "clock" })) as Record<string, unknown>;
    assert.deepEqual(calls, ["/api/plugins/clock/status?wait=1"]);
    assert.equal(out.window, "build 3 loaded");
    assert.equal(out.buildError, null);
  });

  it("passes on a build error and a window crash", async () => {
    const { ctx } = ctxReturning(() => ({
      plugin: info({ state: "error", error: "ui.jsx:4:2: Unexpected \"}\"" }),
      report: { rev: 3, ok: false, error: "x is not defined", at: 1 },
    }));
    const out = (await pluginStatusDef.handler(ctx, { id: "clock" })) as Record<string, unknown>;
    assert.equal(out.buildError, "ui.jsx:4:2: Unexpected \"}\"");
    assert.equal(out.window, "build 3 failed in the window: x is not defined");
  });

  it("a missing folder says how to make one instead of failing", async () => {
    const { ctx } = ctxReturning(() => { throw new Error('daemon 404: {"error":"plugin not found: nope"}'); });
    const out = (await pluginStatusDef.handler(ctx, { id: "nope" })) as Record<string, unknown>;
    assert.equal(out.state, "missing");
  });
});
