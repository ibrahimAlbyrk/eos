import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PluginInstaller } from "../services/PluginInstaller.ts";
import type { PluginFetcher, PluginInstallStore, PluginStaging, StagedFolder } from "../ports/PluginInstall.ts";
import type { PluginBuilder } from "../ports/Plugins.ts";
import type { PluginInfo } from "../../../contracts/src/plugin.ts";
import type { PluginInstallRecord, PluginSource } from "../../../contracts/src/plugin-install.ts";

const NPM: PluginSource = { kind: "npm", name: "eos-clock", version: "1.0.0" };

function harness(opts: { manifest?: unknown; build?: () => void; existing?: string[] } = {}) {
  const calls: string[] = [];
  const folders = new Set(opts.existing ?? []);
  const staged = new Map<string, StagedFolder>();
  let n = 0;
  const staging: PluginStaging = {
    create: () => {
      const id = `st-0000000${++n}`;
      staged.set(id, {
        manifestText: opts.manifest === undefined ? JSON.stringify({ id: "clock", name: "Clock", version: "1.0.0" }) : JSON.stringify(opts.manifest),
        topFiles: ["plugin.json", "ui.jsx"], files: 2, bytes: 300,
      });
      return { id, dir: `/stage/${id}` };
    },
    dir: (id) => (staged.has(id) ? `/stage/${id}` : null),
    inspect: (id) => staged.get(id)!,
    discard: (id) => { calls.push(`discard:${id}`); staged.delete(id); },
    clear: () => { calls.push("clear"); },
    promote: (id, pluginId) => { calls.push(`promote:${id}->${pluginId}`); staged.delete(id); folders.add(pluginId); },
    trash: (pluginId) => { calls.push(`trash:${pluginId}`); folders.delete(pluginId); },
    has: (pluginId) => folders.has(pluginId),
  };
  const recs = new Map<string, PluginInstallRecord>();
  const records: PluginInstallStore = {
    all: () => Object.fromEntries(recs),
    get: (id) => recs.get(id) ?? null,
    set: (id, r) => { recs.set(id, r); },
    remove: (id) => { recs.delete(id); },
  };
  const fetched: PluginSource[] = [];
  const fetcher: PluginFetcher = {
    fetch: async (source) => { fetched.push(source); return { resolved: "https://r/eos-clock-1.0.0.tgz", integrity: "sha512-abc" }; },
  };
  const builder: PluginBuilder = {
    build: async (dir, entry) => { calls.push(`build:${dir}/${entry}`); opts.build?.(); return { js: "", css: null }; },
  };
  const installer = new PluginInstaller({
    fetcher, staging, records, builder,
    plugins: {
      refresh: async (id) => { calls.push(`refresh:${id}`); },
      get: (id) => ({ id, state: "active" } as PluginInfo),
    },
    now: () => 42,
  });
  return { installer, calls, recs, fetched, folders };
}

describe("PluginInstaller", () => {
  it("stages a fetched plugin after checking its manifest and test-building it", async () => {
    const h = harness();
    const s = await h.installer.stage(NPM);
    assert.equal(s.manifest.id, "clock");
    assert.equal(s.integrity, "sha512-abc");
    assert.equal(s.replaces, null);
    assert.deepEqual(h.calls, [`build:/stage/${s.stagingId}/ui.jsx`]);
  });

  it("installs only what was staged, records where it came from and reloads it", async () => {
    const h = harness();
    const s = await h.installer.stage(NPM);
    const info = await h.installer.commit(s.stagingId);
    assert.equal(info.id, "clock");
    assert.deepEqual(h.calls.slice(1), [`promote:${s.stagingId}->clock`, "refresh:clock"]);
    assert.deepEqual(h.recs.get("clock"), { source: NPM, resolved: "https://r/eos-clock-1.0.0.tgz", integrity: "sha512-abc", version: "1.0.0", installedAt: 42 });
    await assert.rejects(h.installer.commit(s.stagingId), /not found/i);
  });

  it("refuses a bad manifest, a reserved id and a plugin that doesn't build — and drops the stage", async () => {
    await assert.rejects(harness({ manifest: { name: "no id" } }).installer.stage(NPM), /not an Eos plugin — plugin\.json/);
    await assert.rejects(harness({ manifest: { id: "eos.pages", name: "x" } }).installer.stage(NPM), /reserved/);
    const h = harness({ build: () => { throw new Error("Could not resolve \"lodash\""); } });
    await assert.rejects(h.installer.stage(NPM), /doesn't build: Could not resolve "lodash"/);
    assert.ok(h.calls.some((c) => c.startsWith("discard:")));
  });

  it("says what a stage would replace: an installed version, or a plugin made here", async () => {
    const mine = harness({ existing: ["clock"] });
    assert.deepEqual((await mine.installer.stage(NPM)).replaces, { version: null, installed: false });
    const h = harness();
    await h.installer.commit((await h.installer.stage(NPM)).stagingId);
    assert.deepEqual((await h.installer.stage(NPM)).replaces, { version: "1.0.0", installed: true });
  });

  it("updates from the same tag, and moves a pinned npm version to latest", async () => {
    const h = harness();
    await h.installer.commit((await h.installer.stage(NPM)).stagingId);
    await h.installer.stageUpdate("clock");
    assert.deepEqual(h.fetched.at(-1), { kind: "npm", name: "eos-clock" });
    const g = harness();
    const git: PluginSource = { kind: "git", url: "https://example.com/clock.git", ref: "main" };
    await g.installer.commit((await g.installer.stage(git)).stagingId);
    await g.installer.stageUpdate("clock");
    assert.deepEqual(g.fetched.at(-1), git);
    await assert.rejects(harness({ existing: ["clock"] }).installer.stageUpdate("clock"), /nothing to update it from/);
  });

  it("removes a plugin to the trash and forgets where it came from", async () => {
    const h = harness();
    await h.installer.commit((await h.installer.stage(NPM)).stagingId);
    await h.installer.remove("clock");
    assert.equal(h.recs.has("clock"), false);
    assert.deepEqual(h.calls.slice(-2), ["trash:clock", "refresh:clock"]);
    await assert.rejects(h.installer.remove("clock"), /not found/i);
  });
});
