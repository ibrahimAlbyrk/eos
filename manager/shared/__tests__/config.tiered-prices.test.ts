import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isTieredPrice, type ModelPriceSpec } from "../../../core/src/domain/value-objects.ts";

// Mirrors config.test.ts: write a temp config.json under EOS_HOME, then load a
// cache-busted copy of config.ts so each assertion sees a fresh merge.
async function freshLoad() {
  const url = new URL(`../config.ts?t=${Date.now()}-${Math.random()}`, import.meta.url);
  const mod = await import(url.href);
  return mod.loadConfig() as ReturnType<typeof import("../config.ts").loadConfig>;
}

describe("config.prices — tiered (context-threshold) overrides", () => {
  let tmpHome: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    tmpHome = (process.env.TMPDIR ?? "/tmp") + `/cfg-tiered-${Date.now()}-${Math.random()}`;
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.EOS_HOME = tmpHome;
  });
  afterEach(async () => {
    delete process.env.EOS_HOME;
    try {
      const fs = await import("node:fs");
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  async function writeConfig(prices: Record<string, unknown>) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(path.join(tmpHome, "config.json"), JSON.stringify({ prices }));
    return freshLoad();
  }

  it("accepts a tiered price and preserves the tiers wholesale", async () => {
    const cfg = await writeConfig({
      "qwen3.7-plus": {
        tiers: [
          { maxInputTokens: 128000, price: { in: 0.4, out: 1.6 } },
          { maxInputTokens: 256000, price: { in: 0.8, out: 3.2 } },
          { maxInputTokens: null, price: { in: 1.2, out: 4.8 } },
        ],
      },
    });
    const spec = cfg.prices["qwen3.7-plus"] as ModelPriceSpec;
    assert.ok(isTieredPrice(spec), "expected a tiered spec");
    assert.equal(spec.tiers.length, 3);
    assert.equal(spec.tiers[0].maxInputTokens, 128000);
    assert.equal(spec.tiers[0].price.in, 0.4);
    assert.equal(spec.tiers[2].maxInputTokens, null);
    assert.equal(spec.tiers[2].price.out, 4.8);
    // Cache rates default to 0 when omitted from a tier.
    assert.equal(spec.tiers[0].price.cacheRead, 0);
    assert.equal(spec.tiers[0].price.cacheCreate, 0);
    assert.equal(spec.tiers[0].price.cacheCreate1h, 0);
  });

  it("a 2-tier Gemini-style override round-trips", async () => {
    const cfg = await writeConfig({
      "gemini-3.1-pro-preview": {
        tiers: [
          { maxInputTokens: 200000, price: { in: 2, out: 12, cacheRead: 0.2 } },
          { maxInputTokens: null, price: { in: 4, out: 18, cacheRead: 0.2 } },
        ],
      },
    });
    const spec = cfg.prices["gemini-3.1-pro-preview"] as ModelPriceSpec;
    assert.ok(isTieredPrice(spec));
    assert.equal(spec.tiers[0].price.cacheRead, 0.2);
    assert.equal(spec.tiers[1].price.in, 4);
  });

  it("keeps existing flat defaults valid alongside a tiered override", async () => {
    const cfg = await writeConfig({
      "qwen3.7-plus": { tiers: [{ maxInputTokens: null, price: { in: 1, out: 2 } }] },
    });
    // Untouched flat defaults remain flat and intact.
    assert.equal(isTieredPrice(cfg.prices.opus), false);
    assert.equal((cfg.prices.opus as { in: number }).in, 15);
    assert.equal((cfg.prices.sonnet as { out: number }).out, 15);
  });

  it("a flat partial override still field-merges (tiered support is additive)", async () => {
    const cfg = await writeConfig({ sonnet: { in: 4.5 } });
    const sonnet = cfg.prices.sonnet as { in: number; out: number; cacheRead: number; cacheCreate1h: number };
    assert.equal(sonnet.in, 4.5);
    assert.equal(sonnet.out, 15);          // preserved default
    assert.equal(sonnet.cacheRead, 0.3);   // preserved default
    assert.equal(sonnet.cacheCreate1h, 6); // preserved default
  });

  it("a tiered override replaces a flat default wholesale (no field bleed-through)", async () => {
    const cfg = await writeConfig({
      sonnet: { tiers: [{ maxInputTokens: null, price: { in: 9, out: 18 } }] },
    });
    const spec = cfg.prices.sonnet as ModelPriceSpec;
    assert.ok(isTieredPrice(spec), "flat default should be replaced by the tiered spec");
    assert.equal(spec.tiers.length, 1);
    assert.equal(spec.tiers[0].price.in, 9);
    // No flat-shape keys leaked onto the spec object.
    assert.equal((spec as unknown as { in?: number }).in, undefined);
  });

  it("rejects a malformed tier (missing required in/out) and keeps defaults", async () => {
    const cfg = await writeConfig({
      "bad-model": { tiers: [{ maxInputTokens: null, price: { cacheRead: 1 } }] },
    });
    // Invalid override is dropped; the model isn't added and flat defaults survive.
    assert.equal(cfg.prices["bad-model"], undefined);
    assert.equal((cfg.prices.opus as { in: number }).in, 15);
  });
});
