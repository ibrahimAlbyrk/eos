import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCostUsd,
  isTieredPrice,
  selectTierPrice,
  type ModelCatalog,
  type ModelPrice,
  type ModelPriceSpec,
} from "../domain/value-objects.ts";

// A catalog that always returns the same spec — isolates tier selection from
// model-name resolution.
const catalogOf = (spec: ModelPriceSpec): ModelCatalog => ({ priceFor: () => spec });

const zeroCache = { cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
const tokens = (inTok: number, outTok: number) => ({ in: inTok, out: outTok, ...zeroCache });

// Costs are floating point; compare within a tight epsilon.
const closeTo = (actual: number, expected: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);

// --- Real shapes from model-research --------------------------------------

// OpenAI GPT-5.5: >272k input ⇒ 2x input / 1.5x output for the whole session.
const OPENAI_GPT55: ModelPriceSpec = {
  tiers: [
    { maxInputTokens: 272000, price: { in: 5, out: 30, cacheRead: 0.5, cacheCreate: 0, cacheCreate1h: 0 } },
    { maxInputTokens: null, price: { in: 10, out: 45, cacheRead: 1.0, cacheCreate: 0, cacheCreate1h: 0 } },
  ],
};

// Gemini 3.1 Pro: ≤200k vs >200k input.
const GEMINI_31_PRO: ModelPriceSpec = {
  tiers: [
    { maxInputTokens: 200000, price: { in: 2, out: 12, cacheRead: 0.2, cacheCreate: 0, cacheCreate1h: 0 } },
    { maxInputTokens: null, price: { in: 4, out: 18, cacheRead: 0.2, cacheCreate: 0, cacheCreate1h: 0 } },
  ],
};

// Qwen-style multi-bucket tiers (0–128k, 128k–256k, >256k), in/out within the
// documented qwen3.7-plus range (0.4–1.2 in / 1.6–4.8 out).
const QWEN_PLUS: ModelPriceSpec = {
  tiers: [
    { maxInputTokens: 128000, price: { in: 0.4, out: 1.6, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 } },
    { maxInputTokens: 256000, price: { in: 0.8, out: 3.2, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 } },
    { maxInputTokens: null, price: { in: 1.2, out: 4.8, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 } },
  ],
};

const FLAT_SONNET: ModelPrice = { in: 3, out: 15, cacheRead: 0.3, cacheCreate: 3.75, cacheCreate1h: 6 };

describe("isTieredPrice", () => {
  it("distinguishes flat from tiered", () => {
    assert.equal(isTieredPrice(FLAT_SONNET), false);
    assert.equal(isTieredPrice(QWEN_PLUS), true);
  });
});

describe("selectTierPrice — flat (degenerate single tier)", () => {
  it("returns the flat price itself regardless of input size", () => {
    assert.equal(selectTierPrice(FLAT_SONNET, 0), FLAT_SONNET);
    assert.equal(selectTierPrice(FLAT_SONNET, 5_000_000), FLAT_SONNET);
  });
});

describe("selectTierPrice — boundaries", () => {
  it("Gemini ≤200k selects tier 1; >200k selects tier 2", () => {
    assert.equal(selectTierPrice(GEMINI_31_PRO, 199_999), GEMINI_31_PRO.tiers[0].price);
    assert.equal(selectTierPrice(GEMINI_31_PRO, 200_000), GEMINI_31_PRO.tiers[0].price); // inclusive upper bound
    assert.equal(selectTierPrice(GEMINI_31_PRO, 200_001), GEMINI_31_PRO.tiers[1].price);
  });

  it("OpenAI ≤272k base; >272k surcharge tier (exactly 2x in / 1.5x out)", () => {
    assert.equal(selectTierPrice(OPENAI_GPT55, 272_000), OPENAI_GPT55.tiers[0].price);
    assert.equal(selectTierPrice(OPENAI_GPT55, 272_001), OPENAI_GPT55.tiers[1].price);
    const base = OPENAI_GPT55.tiers[0].price;
    const surcharge = OPENAI_GPT55.tiers[1].price;
    closeTo(surcharge.in, base.in * 2, "input surcharge");
    closeTo(surcharge.out, base.out * 1.5, "output surcharge");
  });

  it("Qwen multi-bucket selects the right bucket at and across each boundary", () => {
    assert.equal(selectTierPrice(QWEN_PLUS, 0), QWEN_PLUS.tiers[0].price);
    assert.equal(selectTierPrice(QWEN_PLUS, 128_000), QWEN_PLUS.tiers[0].price);
    assert.equal(selectTierPrice(QWEN_PLUS, 128_001), QWEN_PLUS.tiers[1].price);
    assert.equal(selectTierPrice(QWEN_PLUS, 256_000), QWEN_PLUS.tiers[1].price);
    assert.equal(selectTierPrice(QWEN_PLUS, 256_001), QWEN_PLUS.tiers[2].price);
    assert.equal(selectTierPrice(QWEN_PLUS, 900_000), QWEN_PLUS.tiers[2].price);
  });

  it("falls back to the highest tier when every bounded tier is exceeded", () => {
    const allBounded: ModelPriceSpec = {
      tiers: [
        { maxInputTokens: 100, price: { in: 1, out: 1, ...zeroCache } },
        { maxInputTokens: 200, price: { in: 2, out: 2, ...zeroCache } },
      ],
    };
    assert.equal(selectTierPrice(allBounded, 999), allBounded.tiers[1].price);
  });
});

describe("computeCostUsd — flat unchanged", () => {
  it("matches the plain flat formula", () => {
    const cost = computeCostUsd(catalogOf(FLAT_SONNET), "sonnet", {
      in: 1_000_000, out: 500_000, cacheRead: 200_000, cacheCreate: 100_000, cacheCreate1h: 50_000,
    });
    const expected =
      (1_000_000 * 3 + 500_000 * 15 + 200_000 * 0.3 + 100_000 * 3.75 + 50_000 * 6) / 1_000_000;
    closeTo(cost, expected);
  });
});

describe("computeCostUsd — tiered, exact at and across boundaries", () => {
  it("Gemini bills tier 1 at ≤200k and tier 2 above", () => {
    // 200k input → tier 1: 2/12
    closeTo(
      computeCostUsd(catalogOf(GEMINI_31_PRO), "gemini-3.1-pro", tokens(200_000, 10_000)),
      (200_000 * 2 + 10_000 * 12) / 1_000_000,
    );
    // 200_001 input → tier 2: 4/18
    closeTo(
      computeCostUsd(catalogOf(GEMINI_31_PRO), "gemini-3.1-pro", tokens(200_001, 10_000)),
      (200_001 * 4 + 10_000 * 18) / 1_000_000,
    );
  });

  it("OpenAI bills base ≤272k and the 2x/1.5x surcharge above (whole request)", () => {
    closeTo(
      computeCostUsd(catalogOf(OPENAI_GPT55), "gpt-5.5", tokens(272_000, 8_000)),
      (272_000 * 5 + 8_000 * 30) / 1_000_000,
    );
    closeTo(
      computeCostUsd(catalogOf(OPENAI_GPT55), "gpt-5.5", tokens(300_000, 8_000)),
      (300_000 * 10 + 8_000 * 45) / 1_000_000, // entire request billed at the surcharge rate
    );
  });

  it("Qwen bills the right bucket at each boundary", () => {
    // 128k → tier 1 (0.4/1.6)
    closeTo(
      computeCostUsd(catalogOf(QWEN_PLUS), "qwen3.7-plus", tokens(128_000, 4_000)),
      (128_000 * 0.4 + 4_000 * 1.6) / 1_000_000,
    );
    // 128_001 → tier 2 (0.8/3.2)
    closeTo(
      computeCostUsd(catalogOf(QWEN_PLUS), "qwen3.7-plus", tokens(128_001, 4_000)),
      (128_001 * 0.8 + 4_000 * 3.2) / 1_000_000,
    );
    // 300k → tier 3 (1.2/4.8)
    closeTo(
      computeCostUsd(catalogOf(QWEN_PLUS), "qwen3.7-plus", tokens(300_000, 4_000)),
      (300_000 * 1.2 + 4_000 * 4.8) / 1_000_000,
    );
  });

  it("tier is keyed off input tokens, output size never shifts the tier", () => {
    // Huge output, small input → still the lowest Qwen bucket.
    closeTo(
      computeCostUsd(catalogOf(QWEN_PLUS), "qwen3.7-plus", tokens(1_000, 1_000_000)),
      (1_000 * 0.4 + 1_000_000 * 1.6) / 1_000_000,
    );
  });
});

describe("computeCostUsd — cached tokens (the double-count regression)", () => {
  const withCache = (inTok: number, cacheReadTok: number, outTok: number) =>
    ({ in: inTok, out: outTok, cacheRead: cacheReadTok, cacheCreate: 0, cacheCreate1h: 0 });

  it("flat: cached bills ONCE at cacheRead, never also at the input rate", () => {
    // in=non-cached billable input; cacheRead=cached. Cost must be in·inRate +
    // cacheRead·cacheReadRate — NOT (in+cacheRead)·inRate + cacheRead·cacheReadRate.
    const cost = computeCostUsd(catalogOf(FLAT_SONNET), "sonnet", withCache(40, 60, 5));
    closeTo(cost, (40 * 3 + 60 * 0.3 + 5 * 15) / 1_000_000);
  });

  it("tiered: the tier keys off the FULL prompt size (billable + cached), bills cached once", () => {
    // 190k billable + 20k cached = 210k full prompt → Gemini tier 2 (>200k). The
    // input rate applies to the 190k billable slice; the 20k cached bills at tier-2
    // cacheRead, once.
    const cost = computeCostUsd(catalogOf(GEMINI_31_PRO), "gemini-3.1-pro", withCache(190_000, 20_000, 8_000));
    const t2 = GEMINI_31_PRO.tiers[1].price; // in 4, out 18, cacheRead 0.2
    closeTo(cost, (190_000 * t2.in + 20_000 * t2.cacheRead + 8_000 * t2.out) / 1_000_000);
  });

  it("tiered: cached input that pushes the full size over the boundary selects the higher tier", () => {
    // 190k billable alone is tier 1; +20k cached (210k full) crosses into tier 2.
    const t1 = GEMINI_31_PRO.tiers[0].price;
    const t2 = GEMINI_31_PRO.tiers[1].price;
    const noCache = computeCostUsd(catalogOf(GEMINI_31_PRO), "g", withCache(190_000, 0, 0));
    const withC = computeCostUsd(catalogOf(GEMINI_31_PRO), "g", withCache(190_000, 20_000, 0));
    closeTo(noCache, (190_000 * t1.in) / 1_000_000);            // tier 1
    closeTo(withC, (190_000 * t2.in + 20_000 * t2.cacheRead) / 1_000_000); // tier 2
  });
});
