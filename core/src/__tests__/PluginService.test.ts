import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PluginService } from "../services/PluginService.ts";
import type { PluginBuild, PluginDataStore, PluginFolder } from "../ports/Plugins.ts";

const manifest = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, name: id, ...extra });

function setup(folders: Record<string, { manifest: string | null; files?: string[] }>) {
  const published: Array<{ topic: string; payload: unknown }> = [];
  let onChange: (id: string) => void = () => {};
  const builds: string[] = [];
  let failNext: string | null = null;
  const enabled: Record<string, boolean> = {};
  const settings: Record<string, Record<string, unknown>> = {};
  const store: Record<string, Record<string, unknown>> = {};
  const data: PluginDataStore = {
    enabled: () => ({ ...enabled }),
    setEnabled: (id, on) => { enabled[id] = on; },
    settings: (id) => settings[id] ?? {},
    setSettings: (id, v) => { settings[id] = v; },
    storeValue: (id, key) => store[id]?.[key],
    setStoreValue: (id, key, value) => { (store[id] ??= {})[key] = value; },
  };
  const read = (id: string): PluginFolder | null => {
    const f = folders[id];
    return f ? { id, dir: `/p/${id}`, manifestText: f.manifest, files: f.files ?? ["plugin.json", "ui.jsx"] } : null;
  };
  const svc = new PluginService({
    workspace: {
      list: () => Object.keys(folders).map((id) => read(id)!),
      read,
      watch: (fn) => { onChange = fn; return () => {}; },
    },
    builder: {
      build: async (dir, entry): Promise<PluginBuild> => {
        builds.push(`${dir}/${entry}`);
        if (failNext) { const m = failNext; failNext = null; throw new Error(m); }
        return { js: `// ${dir}`, css: null };
      },
    },
    data,
    bus: { publish: (topic, payload) => { published.push({ topic, payload }); } },
    debounceMs: 0,
  });
  return { svc, folders, published, builds, change: (id: string) => onChange(id), failNextBuild: (m: string) => { failNext = m; }, enabled };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 5));

describe("PluginService", () => {
  it("builds every enabled plugin with a UI entry on start", async () => {
    const t = setup({ clock: { manifest: manifest("clock") }, notes: { manifest: manifest("notes"), files: ["plugin.json", "ui.tsx"] } });
    await t.svc.start();
    assert.deepEqual(t.builds.sort(), ["/p/clock/ui.jsx", "/p/notes/ui.tsx"]);
    const clock = t.svc.get("clock");
    assert.equal(clock.state, "active");
    assert.equal(clock.hasUi, true);
    assert.ok(t.svc.bundle("clock", clock.rev));
  });

  it("a file change rebuilds under a new revision; the old one is gone", async () => {
    const t = setup({ clock: { manifest: manifest("clock") } });
    await t.svc.start();
    const first = t.svc.get("clock").rev;
    t.change("clock");
    await settle();
    const second = t.svc.get("clock").rev;
    assert.ok(second > first);
    assert.equal(t.svc.bundle("clock", first), null);
    assert.ok(t.svc.bundle("clock", second));
  });

  it("a failed build reports why and keeps the last good build", async () => {
    const t = setup({ clock: { manifest: manifest("clock") } });
    await t.svc.start();
    const good = t.svc.get("clock").rev;
    t.failNextBuild("ui.jsx:3:1: Unexpected end of file");
    await t.svc.refresh("clock");
    const info = t.svc.get("clock");
    assert.equal(info.state, "error");
    assert.match(info.error ?? "", /Unexpected end of file/);
    assert.equal(info.rev, good);
    assert.equal(info.hasUi, true);
  });

  it("a bad manifest is an error naming the problem; the id must match the folder", async () => {
    const t = setup({ a: { manifest: "{nope" }, b: { manifest: manifest("other") }, c: { manifest: null } });
    await t.svc.start();
    assert.match(t.svc.get("a").error ?? "", /not valid JSON/);
    assert.match(t.svc.get("b").error ?? "", /must match the folder name "b"/);
    assert.match(t.svc.get("c").error ?? "", /plugin.json is missing/);
    assert.equal(t.builds.length, 0);
  });

  it("experimental plugins start off; turning one on builds it", async () => {
    const t = setup({ lab: { manifest: manifest("lab", { experimental: true }) } });
    await t.svc.start();
    assert.equal(t.svc.get("lab").state, "disabled");
    assert.equal(t.builds.length, 0);
    const on = await t.svc.setEnabled("lab", true);
    assert.equal(on.state, "active");
    assert.equal(on.hasUi, true);
    const off = await t.svc.setEnabled("lab", false);
    assert.equal(off.hasUi, false);
    assert.equal(off.rev, 0);
  });

  it("settings fill in defaults, refuse unknown keys and announce the change", async () => {
    const t = setup({ clock: { manifest: manifest("clock", { settings: { seconds: { type: "boolean", title: "Seconds", default: false }, tz: { type: "select", title: "Zone", options: [{ value: "utc", label: "UTC" }], default: "utc" } } }) } });
    await t.svc.start();
    assert.deepEqual(t.svc.get("clock").settings, { seconds: false, tz: "utc" });
    t.published.length = 0;
    assert.deepEqual(t.svc.setSettings("clock", { seconds: true }).settings, { seconds: true, tz: "utc" });
    assert.deepEqual(t.published, [{ topic: "plugins:change", payload: { id: "clock" } }]);
    assert.throws(() => t.svc.setSettings("clock", { nope: 1 }), /no setting "nope"/);
  });

  it("a stored value is kept and announced on the plugin's own topic", async () => {
    const t = setup({ notes: { manifest: manifest("notes") } });
    await t.svc.start();
    t.svc.setStoreValue("notes", "list", [{ text: "hi" }]);
    assert.deepEqual(t.svc.storeValue("notes", "list"), [{ text: "hi" }]);
    assert.deepEqual(t.published.at(-1), { topic: "plugin:notes:store", payload: { key: "list" } });
  });

  it("a deleted folder drops the plugin", async () => {
    const t = setup({ clock: { manifest: manifest("clock") } });
    await t.svc.start();
    delete t.folders.clock;
    t.change("clock");
    await settle();
    assert.deepEqual(t.svc.list(), []);
    assert.throws(() => t.svc.get("clock"), /plugin not found/);
  });

  it("changes during a build rebuild once more after it", async () => {
    const t = setup({ clock: { manifest: manifest("clock") } });
    await t.svc.start();
    t.builds.length = 0;
    const a = t.svc.refresh("clock");
    void t.svc.refresh("clock");
    void t.svc.refresh("clock");
    await a;
    await settle();
    assert.equal(t.builds.length, 2);
  });
});
