// LiteLLM-backed ModelPricingCatalog. Loads the public cross-provider pricing map
// (model id → per-TOKEN costs) maintained at BerriAI/litellm, converts every entry
// to Eos per-MILLION ModelPrice, and indexes it in memory for SYNC lookups. Cached
// to ~/.eos/model-pricing-cache.json with a 24h TTL + stale-while-revalidate, and a
// small BUNDLED fallback (incl. deepseek) keeps lookups working offline / first-run.
//
// FAIL-SOFT throughout: a network/parse error never throws to the caller — the
// catalog keeps serving the cached (then bundled) prices. The constructor seeds the
// in-memory index synchronously (bundled → disk cache), so lookups work the instant
// it exists; start() kicks the background refresh.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { ModelPricingCatalog } from "../../../core/src/ports/ModelPricingCatalog.ts";
import type { ModelPrice } from "../../../core/src/domain/value-objects.ts";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const PER_MILLION = 1_000_000;

// The subset of a LiteLLM entry we consume — all costs are per-TOKEN (USD).
interface LiteLlmEntry {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  input_cost_per_token_cache_hit?: unknown;
  cache_creation_input_token_cost?: unknown;
}
export type LiteLlmRawMap = Record<string, unknown>;
export type FetchPricingSource = () => Promise<LiteLlmRawMap>;

// Bundled offline floor — a handful of common models (incl. deepseek) priced
// per-MILLION tokens (USD), so the catalog resolves on first-run / offline before
// the live map arrives. The live LiteLLM map overrides these at refresh; config
// .prices overrides everything (a manual price always wins, set at priceForModel).
export const BUNDLED_PRICES: Record<string, ModelPrice> = {
  "deepseek-chat": { in: 0.28, out: 0.42, cacheRead: 0.028, cacheCreate: 0, cacheCreate1h: 0 },
  "deepseek-reasoner": { in: 0.28, out: 0.42, cacheRead: 0.028, cacheCreate: 0, cacheCreate1h: 0 },
  "deepseek-v4-flash": { in: 0.14, out: 0.28, cacheRead: 0.0028, cacheCreate: 0, cacheCreate1h: 0 },
  "deepseek-v4-pro": { in: 0.435, out: 0.87, cacheRead: 0.003625, cacheCreate: 0, cacheCreate1h: 0 },
  "gpt-4o": { in: 5, out: 15, cacheRead: 1.5, cacheCreate: 15, cacheCreate1h: 15 },
  "gpt-4o-mini": { in: 0.15, out: 0.6, cacheRead: 0.075, cacheCreate: 0.6, cacheCreate1h: 0.6 },
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// One LiteLLM entry → ModelPrice (per-TOKEN → per-MILLION). Returns null when the
// entry carries no usable input/output cost. LiteLLM has no 1h-cache tier, so
// cacheCreate1h reuses the (5-minute) creation cost.
export function liteLlmEntryToPrice(raw: unknown): ModelPrice | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as LiteLlmEntry;
  const inTok = num(e.input_cost_per_token);
  const outTok = num(e.output_cost_per_token);
  if (inTok == null && outTok == null) return null;
  const cacheRead = num(e.cache_read_input_token_cost) ?? num(e.input_cost_per_token_cache_hit) ?? 0;
  const cacheCreate = num(e.cache_creation_input_token_cost) ?? 0;
  return {
    in: (inTok ?? 0) * PER_MILLION,
    out: (outTok ?? 0) * PER_MILLION,
    cacheRead: cacheRead * PER_MILLION,
    cacheCreate: cacheCreate * PER_MILLION,
    cacheCreate1h: cacheCreate * PER_MILLION,
  };
}

// Whole raw map → flat { lowercased id → ModelPrice }, dropping the catalog's
// "sample_spec" meta key and any entry without usable pricing.
export function convertRawMap(raw: LiteLlmRawMap): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, entry] of Object.entries(raw)) {
    if (key === "sample_spec") continue;
    const price = liteLlmEntryToPrice(entry);
    if (price) out[key.toLowerCase()] = price;
  }
  return out;
}

function segCount(key: string): number {
  return key.split("/").length;
}

// Builds the lookup indexes from a flat (already-lowercased) price map: an exact
// map by full id, plus a suffix map (bare id after the last "/" → most-canonical
// prefixed entry) so a provider-prefixed catalog key resolves from a bare query.
function buildIndex(flat: Record<string, ModelPrice>): {
  exact: Map<string, ModelPrice>;
  suffix: Map<string, { key: string; price: ModelPrice }>;
} {
  const exact = new Map<string, ModelPrice>();
  const suffix = new Map<string, { key: string; price: ModelPrice }>();
  for (const [k, price] of Object.entries(flat)) {
    exact.set(k, price);
    const bare = k.slice(k.lastIndexOf("/") + 1);
    if (bare !== k) {
      const cur = suffix.get(bare);
      if (!cur || segCount(k) < segCount(cur.key)) suffix.set(bare, { key: k, price });
    }
  }
  return { exact, suffix };
}

export class LiteLlmModelPricingCatalog implements ModelPricingCatalog {
  private flat: Record<string, ModelPrice> = {};
  private exact = new Map<string, ModelPrice>();
  private suffix = new Map<string, { key: string; price: ModelPrice }>();
  private readonly cacheFile: string;
  private readonly clock: Clock;
  private readonly fetchSource: FetchPricingSource;
  private fetchedAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(opts: { cacheFile: string; clock: Clock; fetchSource?: FetchPricingSource }) {
    this.cacheFile = opts.cacheFile;
    this.clock = opts.clock;
    this.fetchSource = opts.fetchSource ?? fetchLiteLlmMap;
    // Seed synchronously so the very first lookup works: bundled floor, then the
    // disk cache (broader/fresher) on top.
    this.merge(BUNDLED_PRICES);
    const disk = this.readDisk();
    if (disk) {
      this.merge(disk.prices);
      this.fetchedAt = disk.fetchedAt;
    }
  }

  lookup(model: string | null | undefined): ModelPrice | null {
    if (model == null) return null;
    const m = String(model).trim().toLowerCase();
    if (!m) return null;
    const hit = this.exact.get(m);
    if (hit) return hit;
    if (m.includes("/")) {
      // Query carries a provider prefix → try the bare id (exact, then suffix).
      const bare = m.slice(m.lastIndexOf("/") + 1);
      return this.exact.get(bare) ?? this.suffix.get(bare)?.price ?? null;
    }
    // Bare query → try a provider-prefixed catalog key.
    return this.suffix.get(m)?.price ?? null;
  }

  // Fire-and-forget background refresh when the cache is missing or stale. Called
  // once at startup; safe to call repeatedly (de-duped). Never throws.
  start(): void {
    if (this.fetchedAt && this.clock.now() - this.fetchedAt <= TTL_MS) return;
    void this.refresh();
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.fetchSource()
      .then((raw) => {
        const flat = convertRawMap(raw);
        if (Object.keys(flat).length === 0) return;
        this.merge(flat);
        this.fetchedAt = this.clock.now();
        this.writeDisk({ fetchedAt: this.fetchedAt, prices: this.flat });
      })
      .catch(() => {
        // FAIL-SOFT: keep serving the cached/bundled prices.
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private merge(flat: Record<string, ModelPrice>): void {
    for (const [k, v] of Object.entries(flat)) this.flat[k.toLowerCase()] = v;
    const idx = buildIndex(this.flat);
    this.exact = idx.exact;
    this.suffix = idx.suffix;
  }

  private readDisk(): { fetchedAt: number; prices: Record<string, ModelPrice> } | null {
    if (!existsSync(this.cacheFile)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      const p = parsed as Record<string, unknown>;
      const fetchedAt = typeof p.fetchedAt === "number" ? p.fetchedAt : 0;
      const prices = p.prices && typeof p.prices === "object"
        ? (p.prices as Record<string, ModelPrice>)
        : {};
      return { fetchedAt, prices };
    } catch {
      return null;
    }
  }

  private writeDisk(cache: { fetchedAt: number; prices: Record<string, ModelPrice> }): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
      renameSync(tmp, this.cacheFile);
    } catch {
      // Cache is best-effort; the in-memory index still serves this run.
    }
  }
}

async function fetchLiteLlmMap(): Promise<LiteLlmRawMap> {
  const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`litellm pricing fetch failed: ${res.status}`);
  const body = await res.json();
  if (!body || typeof body !== "object") throw new Error("litellm pricing: unexpected shape");
  return body as LiteLlmRawMap;
}
