// POST /api/backends — the add-provider write route (§7.2). Validates + normalizes
// the request, stores the API key in the Keychain BY REFERENCE (never in
// config.json), writes the BackendProfile (+ any new price) to ~/.eos/config.json,
// then reloads. The raw key never touches config.json / SQLite / logs.
//
// validateAddBackend is exported as a PURE function (no disk, no Keychain) so the
// baseUrl-normalize + billed-needs-price rules are unit-tested directly.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { AddBackendRequestSchema, type AddBackendRequest, type BackendModelsResponse } from "../../contracts/src/http.ts";
import type { BackendProfile, AuthRef } from "../../contracts/src/backend.ts";
import type { BackendKind } from "../../contracts/src/canonical.ts";
import type { BackendDescriptor } from "../../core/src/ports/AgentBackend.ts";
import type { ResolvedAuth } from "../../core/src/ports/AuthResolver.ts";
import { TestBackendRequestSchema, type TestBackendRequest, type TestBackendResponse } from "../../contracts/src/http.ts";
import { normalizeBaseOrigin, modelsPathFor } from "../../infra/src/backends/base-url.ts";
import { writeKeychainSecret } from "../../infra/src/auth/SubscriptionAuthResolver.ts";
import { billedProfileNeedsPrice, type ModelPrice, type ModelPriceSpec } from "../shared/config.ts";
import { PROVIDER_PRESETS, findPreset, fallbackModelsForBaseUrl, type ProviderPreset } from "../shared/provider-presets.ts";
import { errMsg } from "../../contracts/src/util.ts";

export interface PreparedBackend {
  name: string;
  profile: BackendProfile;
  // The price-table key (lowercased model / pricing key) + the price to write, when
  // the request supplied one for a billed profile.
  priceKey?: string;
  price?: ModelPrice;
}

// Pure validation + normalization. existingPrices is the merged config.prices and
// catalogLookup is the auto-pricing catalog, so a billed profile whose model is
// priced by EITHER needs no inline price. A billed profile with no resolvable price
// is accepted with a WARNING (never rejected) — it bills at the loud known-zero
// until a price is available; adding only an API key must be enough to add a provider.
export function validateAddBackend(
  req: AddBackendRequest,
  existingPrices: Record<string, ModelPriceSpec>,
  catalogLookup?: (model: string) => ModelPrice | null,
  preset?: ProviderPreset,
): { ok: true; prepared: PreparedBackend; warnings?: string[] } | { ok: false; error: string } {
  // A preset fills the connection config the body omits (so { name, preset, apiKey }
  // is enough); explicit fields still win. Resolve everything against it first.
  const kind: BackendKind | undefined = req.kind ?? preset?.kind;
  const model = req.model ?? preset?.defaultModel;
  if (!kind) return { ok: false, error: "kind is required (or supply a known preset)" };
  if (!model) return { ok: false, error: "model is required (or supply a known preset)" };
  // baseUrl is an ORIGIN ONLY — strip a trailing slash or "/v1" so the client's
  // "/v1/..." path never double-joins (MJ1).
  const rawBaseUrl = req.baseUrl ?? preset?.baseUrl;
  const baseUrl = rawBaseUrl ? normalizeBaseOrigin(rawBaseUrl) : undefined;
  const capabilities = req.capabilities ?? preset?.capabilities;
  const costMode = req.costMode ?? (preset ? "billed" : undefined);
  // No explicit auth + a preset ⇒ store the key in the preset's Keychain ref.
  const auth: AuthRef | undefined = req.auth ?? (preset ? { kind: "keychain", ref: preset.authRef } : undefined);
  // A keychain auth ref is required to know WHERE to store the key.
  if (auth?.kind === "keychain" && !auth.ref) {
    return { ok: false, error: "auth.ref (Keychain service id) is required for a keychain credential" };
  }
  if (auth?.kind === "keychain" && auth.ref && !req.apiKey) {
    return { ok: false, error: "apiKey is required to store a keychain credential" };
  }
  const profile: BackendProfile = {
    kind,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(auth ? { auth } : {}),
    ...(costMode ? { costMode } : {}),
    ...(req.params ? { params: req.params } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
  const priceKey = (profile.pricing ?? profile.model).toLowerCase();
  const warnings: string[] = [];
  // A billed profile bills at the loud known-zero if no price resolves. Merge the
  // inline price (if any), then consult the catalog. Only WARN — never reject — so a
  // provider can be added with just {name, kind, baseUrl, apiKey} (MJ2).
  const mergedPrices = req.price ? { ...existingPrices, [priceKey]: toFullPrice(req.price) } : existingPrices;
  if (billedProfileNeedsPrice(profile, mergedPrices, catalogLookup)) {
    warnings.push(`backend "${req.name}" is costMode:"billed" with no resolvable price (config.prices or pricing catalog) for model "${profile.model}" — its turns bill at zero until a price is available; add config.prices["${priceKey}"] to override.`);
  }
  // Non-fatal: a profile with no declared capabilities can't drive the in-process
  // lane's near-window compaction or reasoning round-trip — on a small-context or
  // local model it grows history unbounded and 400s with no recovery (m3). Warn
  // rather than reject (the claude lanes don't need capabilities). contextWindow is
  // schema-required once capabilities is present, so the only gap is omitting it.
  if (!capabilities) {
    warnings.push(`backend "${req.name}" declares no "capabilities" — the in-process lane cannot compact near the context window; declare capabilities (incl. contextWindow) for a small-context or local model.`);
  }
  return {
    ok: true,
    prepared: { name: req.name, profile, ...(req.price ? { priceKey, price: toFullPrice(req.price) } : {}) },
    ...(warnings.length ? { warnings } : {}),
  };
}

// The UI price shape (in/out/cacheRead/cacheCreate) → the config ModelPrice
// (adds cacheCreate1h). Missing cache fields default to 0 for a new provider.
function toFullPrice(p: { in: number; out: number; cacheRead: number; cacheCreate: number }): ModelPrice {
  return { in: p.in, out: p.out, cacheRead: p.cacheRead, cacheCreate: p.cacheCreate, cacheCreate1h: p.cacheCreate * 2 };
}

// Default origin per wire dialect when a profile omits baseUrl. Branches on the
// descriptor's DATA (wireDialect), never a kind literal.
const DIALECT_DEFAULT_ORIGIN: Record<string, string> = {
  "openai-chat": "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

// Auth header for a provider's models GET, mirroring the model clients: anthropic →
// x-api-key (+ version); openai-chat → Authorization: Bearer, UNLESS the profile
// declares authStyle:"x-goog-api-key" (Gemini), which sends the key in that header
// with no Authorization. Keyless (no resolved key — e.g. a localhost proxy) → no
// auth header.
function modelsAuthHeaders(dialect: string | undefined, apiKey: string | undefined, authStyle?: string): Record<string, string> {
  if (dialect === "anthropic") {
    return { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) };
  }
  if (!apiKey) return {};
  return authStyle === "x-goog-api-key" ? { "x-goog-api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
}

// in/out per-MILLION-token price for a model id. Provider-endpoint pricing (when the
// /v1/models row carries it, OpenRouter-style) is PREFERRED over the catalog.
type PriceAnnotation = { in: number; out: number };

// OpenRouter-style per-model pricing on a /v1/models row: data[].pricing.{prompt,
// completion} are USD-per-TOKEN (strings or numbers). → per-MILLION in/out, or null
// when the row carries no usable pricing.
function parseProviderPricing(row: Record<string, unknown>): PriceAnnotation | null {
  const p = row?.pricing;
  if (!p || typeof p !== "object") return null;
  const pp = p as Record<string, unknown>;
  const inTok = toNum(pp.prompt ?? pp.input);
  const outTok = toNum(pp.completion ?? pp.output);
  if (inTok == null && outTok == null) return null;
  return { in: (inTok ?? 0) * 1e6, out: (outTok ?? 0) * 1e6 };
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// A configured provider's available model ids for the two-level composer picker.
// A request-model lane (claude-cli/claude-sdk) shares the Claude catalog — no
// provider call. A profile-model lane (openai/anthropic-api/codex) fetches its
// provider's /v1/models with the resolved key + dialect auth header. Branches on
// the descriptor's DATA (modelSource/wireDialect), never a kind literal. fetch is
// injectable so the mapping + fail-soft paths are unit-tested with no billed call.
// Each id is annotated with its resolved price (provider-endpoint pricing preferred,
// else the auto-pricing catalog via priceFor) so the picker can show it.
// FAIL-SOFT: any auth/network/parse failure returns the profile's pinned model
// alone plus an `error` — the picker never 500s.
export async function fetchBackendModels(opts: {
  profile: BackendProfile;
  descriptor: BackendDescriptor | null;
  claudeCatalogIds: () => Promise<string[]>;
  resolveAuth: (_auth: AuthRef | undefined) => Promise<ResolvedAuth>;
  priceFor?: (model: string) => ModelPrice | null;
  fetchImpl?: typeof fetch;
}): Promise<BackendModelsResponse> {
  const { profile, descriptor } = opts;
  if (descriptor && descriptor.modelSource === "request") {
    const ids = await opts.claudeCatalogIds().catch(() => [] as string[]);
    return { models: ids.length ? ids : [profile.model] };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const dialect = descriptor?.wireDialect;
  const base = normalizeBaseOrigin(profile.baseUrl ?? DIALECT_DEFAULT_ORIGIN[dialect ?? "openai-chat"] ?? "https://api.openai.com");
  const modelsPath = modelsPathFor(profile.capabilities?.chatCompletionsPath);
  // When the live list can't be fetched, the picker shows the provider's static
  // fallback (preset) list — pinned model first — so it's never empty.
  const fallback = (error: string): BackendModelsResponse => {
    const preset = fallbackModelsForBaseUrl(profile.baseUrl);
    const models = [profile.model, ...(preset ?? [])].filter((m, i, a) => a.indexOf(m) === i);
    return { models, error };
  };
  try {
    const auth = await opts.resolveAuth(profile.auth);
    const resp = await doFetch(`${base}${modelsPath}`, { headers: modelsAuthHeaders(dialect, auth.apiKey, profile.capabilities?.authStyle) });
    if (!resp.ok) return fallback(`provider returned HTTP ${resp.status}`);
    const data = (await resp.json()) as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(data?.data) ? data.data : [];
    const ids: string[] = [];
    const prices: Record<string, PriceAnnotation> = {};
    for (const row of rows) {
      const id = typeof row?.id === "string" && row.id.length > 0 ? row.id : null;
      if (!id) continue;
      ids.push(id);
      const fromProvider = parseProviderPricing(row);
      const resolved = fromProvider ?? toAnnotation(opts.priceFor?.(id));
      if (resolved) prices[id] = resolved;
    }
    if (!ids.length) return fallback("provider returned no models");
    return Object.keys(prices).length ? { models: ids, prices } : { models: ids };
  } catch (e) {
    return fallback(errMsg(e));
  }
}

function toAnnotation(p: ModelPrice | null | undefined): PriceAnnotation | null {
  return p ? { in: p.in, out: p.out } : null;
}

export function registerBackendsRoutes(r: Router, c: Container): void {
  // Short in-memory cache (60s) of a profile's model list, keyed by profile name —
  // the picker re-opens a row repeatedly; don't re-hit the provider each time.
  const modelsCache = new Map<string, { at: number; result: BackendModelsResponse }>();
  const MODELS_CACHE_MS = 60_000;

  // GET /api/backends/:name/models — the two-level picker's lazy model fetch.
  r.get(/^\/api\/backends\/(?<name>[^/]+)\/models$/, async ({ params, res }) => {
    const name = decodeURIComponent(params.name);
    const profile = c.config.backends[name];
    if (!profile) { writeJson(res, 404, { error: `backend "${name}" not found` }); return; }
    const now = Date.now();
    const hit = modelsCache.get(name);
    if (hit && now - hit.at < MODELS_CACHE_MS) { writeJson(res, 200, hit.result); return; }
    const descriptor = c.backends.has(profile.kind) ? c.backends.get(profile.kind).descriptor : null;
    const result = await fetchBackendModels({
      profile,
      descriptor,
      claudeCatalogIds: async () => (await c.modelCatalog.get()).map((m) => m.id),
      resolveAuth: (a) => c.authResolver.resolve(a),
      priceFor: (m) => c.modelPricing.lookup(m),
    });
    modelsCache.set(name, { at: now, result });
    writeJson(res, 200, result);
  });

  // GET /api/backends/presets — the built-in add-provider presets, summarized so a
  // picker can list them; POST { name, preset:id, apiKey } adds one with just a key.
  r.get("/api/backends/presets", ({ res }) => {
    writeJson(res, 200, {
      presets: PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl, defaultModel: p.defaultModel })),
    });
  });

  r.post("/api/backends", async ({ req, res }) => {
    const body = validate(AddBackendRequestSchema, await readBody(req));
    // A `preset` body field selects a built-in provider; an unknown id is rejected.
    const preset = body.preset ? findPreset(body.preset) : undefined;
    if (body.preset && !preset) { writeJson(res, 400, { error: `unknown preset "${body.preset}"` }); return; }
    const result = validateAddBackend(body, c.config.prices, (m) => c.modelPricing.lookup(m), preset);
    if (!result.ok) { writeJson(res, 400, { error: result.error }); return; }
    const { prepared } = result;
    for (const w of result.warnings ?? []) c.log.warn("add-backend", { warning: w });

    // Store the key in the Keychain by reference (keychain kinds only) — using the
    // RESOLVED auth (a preset supplies the ref when the body omits it). The raw key
    // is then dropped — only auth:{kind,ref} reaches config.json.
    const resolvedAuth = prepared.profile.auth;
    if (resolvedAuth?.kind === "keychain" && resolvedAuth.ref && body.apiKey) {
      try {
        writeKeychainSecret(resolvedAuth.ref, body.apiKey);
      } catch (e) {
        writeJson(res, 500, { error: `failed to store API key in Keychain: ${errMsg(e)}` });
        return;
      }
    }

    // Persist the profile (+ any new price) to ~/.eos/config.json, then reload so the
    // resolver sees it immediately. We merge into the on-disk file (not the frozen
    // in-memory config) so hand-edits survive.
    try {
      const path = join(c.config.daemon.home, "config.json");
      const existing = readConfigJson(path);
      const backends = (existing.backends ?? {}) as Record<string, unknown>;
      backends[prepared.name] = prepared.profile;
      existing.backends = backends;
      if (prepared.price && prepared.priceKey) {
        const prices = (existing.prices ?? {}) as Record<string, unknown>;
        prices[prepared.priceKey] = prepared.price;
        existing.prices = prices;
      }
      writeFileSync(path, JSON.stringify(existing, null, 2));
      c.reloadConfig();
    } catch (e) {
      writeJson(res, 500, { error: `failed to write config: ${errMsg(e)}` });
      return;
    }

    writeJson(res, 201, { name: prepared.name, kind: prepared.profile.kind, model: prepared.profile.model, baseUrl: prepared.profile.baseUrl });
  });

  // POST /api/backends/test — ephemeral connection test. Builds a profile IN MEMORY
  // from a preset + apiKey, resolves the key IN MEMORY (NEVER persists, NEVER writes
  // Keychain), and does a live connectivity check via the provider's /v1/models.
  r.post("/api/backends/test", async ({ req, res }) => {
    const body = validate(TestBackendRequestSchema, await readBody(req)) as TestBackendRequest;
    const preset = body.preset ? findPreset(body.preset) : undefined;
    if (body.preset && !preset) {
      writeJson(res, 400, { ok: false, error: `unknown preset "${body.preset}"` });
      return;
    }
    const kind: BackendKind | undefined = body.kind ?? preset?.kind;
    const model = body.model ?? preset?.defaultModel;
    if (!kind || !model) {
      writeJson(res, 400, { ok: false, error: "kind and model are required (or supply a known preset)" });
      return;
    }
    if (!body.apiKey) {
      writeJson(res, 400, { ok: false, error: "apiKey is required" });
      return;
    }

    // Build an EPHEMERAL profile — same shape as a persisted one but never stored.
    const rawBaseUrl = body.baseUrl ?? preset?.baseUrl;
    const baseUrl = rawBaseUrl ? normalizeBaseOrigin(rawBaseUrl) : undefined;
    const profile: BackendProfile = {
      kind,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(preset?.capabilities || body.capabilities ? { capabilities: body.capabilities ?? preset?.capabilities } : {}),
      costMode: "billed",
    };

    // Resolve the key IN MEMORY — bypass Keychain entirely.
    const descriptor: BackendDescriptor | null = c.backends.has(kind) ? c.backends.get(kind).descriptor : null;
    const inMemoryKey = body.apiKey;

    let liveResult: TestBackendResponse;
    try {
      const modelsResult = await fetchBackendModels({
        profile,
        descriptor,
        claudeCatalogIds: async () => [],
        resolveAuth: async () => ({ scheme: "apikey" as const, apiKey: inMemoryKey }),
        priceFor: (m) => c.modelPricing.lookup(m),
        fetchImpl: fetch,
      });
      if (modelsResult.error) {
        liveResult = { ok: false, error: modelsResult.error };
      } else {
        liveResult = { ok: true, models: modelsResult.models };
      }
    } catch (e) {
      liveResult = { ok: false, error: errMsg(e) };
    }
    writeJson(res, liveResult.ok ? 200 : 400, liveResult);
  });

  // DELETE /api/backends/:name — remove a configured provider profile.
  r.del(/^\/api\/backends\/(?<name>[^/]+)$/, async ({ params, res }) => {
    const name = decodeURIComponent(params.name);
    if (!c.config.backends[name]) {
      writeJson(res, 404, { error: `backend "${name}" not found` });
      return;
    }
    try {
      const path = join(c.config.daemon.home, "config.json");
      const existing = readConfigJson(path);
      const backends = (existing.backends ?? {}) as Record<string, unknown>;
      delete backends[name];
      existing.backends = backends;
      writeFileSync(path, JSON.stringify(existing, null, 2));
      c.reloadConfig();
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: `failed to remove backend: ${errMsg(e)}` });
    }
  });
}

function readConfigJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
