import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  LiteLlmModelPricingCatalog,
  liteLlmEntryToPrice,
  convertRawMap,
  BUNDLED_PRICES,
  type LiteLlmRawMap,
} from "../backends/ModelPricingCatalog.ts";

const fakeClock = { now: () => 1_000_000 };
const tmpCache = () => join(mkdtempSync(join(tmpdir(), "eos-pricing-")), "cache.json");
const approx = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// per-TOKEN values from the real LiteLLM map; the catalog stores per-MILLION.
const FAKE_SOURCE: LiteLlmRawMap = {
  sample_spec: { input_cost_per_token: 999, output_cost_per_token: 999 },
  "deepseek-v4-flash": {
    input_cost_per_token: 1.4e-7,
    output_cost_per_token: 2.8e-7,
    cache_read_input_token_cost: 2.8e-9,
    cache_creation_input_token_cost: 0,
    litellm_provider: "deepseek",
  },
  "openrouter/acme/wonder-model": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
  },
  "no-price-model": { litellm_provider: "x", max_input_tokens: 1000 },
};

describe("liteLlmEntryToPrice — per-token → per-million", () => {
  it("converts input/output/cache costs to per-million", () => {
    const p = liteLlmEntryToPrice(FAKE_SOURCE["deepseek-v4-flash"])!;
    assert.ok(p);
    approx(p.in, 0.14);
    approx(p.out, 0.28);
    approx(p.cacheRead, 0.0028);
    approx(p.cacheCreate, 0);
    approx(p.cacheCreate1h, 0);
  });

  it("returns null for an entry with no usable input/output cost", () => {
    assert.equal(liteLlmEntryToPrice(FAKE_SOURCE["no-price-model"]), null);
    assert.equal(liteLlmEntryToPrice(null), null);
  });
});

describe("convertRawMap", () => {
  it("drops sample_spec + unpriced entries, lowercases keys", () => {
    const flat = convertRawMap(FAKE_SOURCE);
    assert.equal(flat["sample_spec"], undefined);
    assert.equal(flat["no-price-model"], undefined);
    assert.ok(flat["deepseek-v4-flash"]);
    assert.ok(flat["openrouter/acme/wonder-model"]);
  });
});

describe("LiteLlmModelPricingCatalog.lookup — id normalization", () => {
  it("resolves exact, case-insensitive, stripped, and provider-prefixed forms", async () => {
    const cat = new LiteLlmModelPricingCatalog({
      cacheFile: tmpCache(),
      clock: fakeClock,
      fetchSource: async () => FAKE_SOURCE,
    });
    await cat.refresh();

    // exact
    approx(cat.lookup("deepseek-v4-flash")!.in, 0.14);
    // case-insensitive
    approx(cat.lookup("DeepSeek-V4-Flash")!.out, 0.28);
    // stripped: query carries a provider prefix, only the bare id is in the map
    approx(cat.lookup("deepseek/deepseek-v4-flash")!.in, 0.14);
    // provider-prefixed: bare query, only the prefixed id is in the map
    approx(cat.lookup("wonder-model")!.in, 1.0);
    approx(cat.lookup("wonder-model")!.out, 2.0);
    // unknown
    assert.equal(cat.lookup("totally-unknown-model"), null);
    assert.equal(cat.lookup(null), null);
    assert.equal(cat.lookup(""), null);
  });
});

describe("LiteLlmModelPricingCatalog — fail-soft", () => {
  it("serves the bundled fallback when the source throws (no cache, offline)", async () => {
    const cat = new LiteLlmModelPricingCatalog({
      cacheFile: tmpCache(),
      clock: fakeClock,
      fetchSource: async () => {
        throw new Error("network down");
      },
    });
    // refresh must not reject even though the source threw.
    await cat.refresh();
    const ds = cat.lookup("deepseek-chat")!;
    assert.ok(ds);
    assert.deepEqual(ds, BUNDLED_PRICES["deepseek-chat"]);
  });

  it("an empty/garbage source map leaves the bundled floor intact", async () => {
    const cat = new LiteLlmModelPricingCatalog({
      cacheFile: tmpCache(),
      clock: fakeClock,
      fetchSource: async () => ({}) as LiteLlmRawMap,
    });
    await cat.refresh();
    assert.ok(cat.lookup("gpt-4o"));
  });
});
