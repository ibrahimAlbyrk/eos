import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { genuiSettingsOf } from "../genui-settings.ts";

// loadConfig memoizes per module instance — a fresh import per test.
async function freshLoad() {
  const url = new URL(`../config.ts?t=${Date.now()}-${Math.random()}`, import.meta.url);
  const mod = await import(url.href);
  return mod.loadConfig() as ReturnType<typeof import("../config.ts").loadConfig>;
}

describe("config.genui", () => {
  let home: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env.EOS_HOME;
    home = mkdtempSync(join(tmpdir(), "eos-cfg-genui-"));
    process.env.EOS_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.EOS_HOME;
    else process.env.EOS_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("defaults to no logo key", async () => {
    const cfg = await freshLoad();
    assert.deepEqual(cfg.genui, {});
    assert.equal(genuiSettingsOf({}, cfg).logoDevKey, null);
  });

  it("loads a logo key from config.json", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ genui: { logoDevKey: "pk_abc123XYZ" } }));
    const cfg = await freshLoad();
    assert.equal(cfg.genui.logoDevKey, "pk_abc123XYZ");
    assert.equal(genuiSettingsOf({}, cfg).logoDevKey, "pk_abc123XYZ");
  });

  it("a malformed key doesn't sink the rest of config.json — it reads as no key", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ daemon: { port: 8123 }, genui: { logoDevKey: "sk_secret" } }));
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 8123);
    assert.equal(genuiSettingsOf({}, cfg).logoDevKey, null);
  });
});
