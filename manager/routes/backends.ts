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
import type { BackendDescriptor } from "../../core/src/ports/AgentBackend.ts";
import type { ResolvedAuth } from "../../core/src/ports/AuthResolver.ts";
import { normalizeBaseOrigin } from "../../infra/src/backends/base-url.ts";
import { writeKeychainSecret } from "../../infra/src/auth/SubscriptionAuthResolver.ts";
import { billedProfileNeedsPrice, type ModelPrice } from "../shared/config.ts";
import { errMsg } from "../../contracts/src/util.ts";

export interface PreparedBackend {
  name: string;
  profile: BackendProfile;
  // The price-table key (lowercased model / pricing key) + the price to write, when
  // the request supplied one for a billed profile.
  priceKey?: string;
  price?: ModelPrice;
}

// Pure validation + normalization. existingPrices is the merged config.prices, so a
// billed profile whose model is already priced needs no inline price.
export function validateAddBackend(
  req: AddBackendRequest,
  existingPrices: Record<string, ModelPrice>,
): { ok: true; prepared: PreparedBackend; warnings?: string[] } | { ok: false; error: string } {
  // baseUrl is an ORIGIN ONLY — strip a trailing slash or "/v1" so the client's
  // "/v1/..." path never double-joins (MJ1).
  const baseUrl = req.baseUrl ? normalizeBaseOrigin(req.baseUrl) : undefined;
  // A keychain auth ref is required to know WHERE to store the key.
  if (req.auth?.kind === "keychain" && !req.auth.ref) {
    return { ok: false, error: "auth.ref (Keychain service id) is required for a keychain credential" };
  }
  if (req.auth?.kind === "keychain" && req.auth.ref && !req.apiKey) {
    return { ok: false, error: "apiKey is required to store a keychain credential" };
  }
  const profile: BackendProfile = {
    kind: req.kind,
    model: req.model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(req.auth ? { auth: req.auth } : {}),
    ...(req.costMode ? { costMode: req.costMode } : {}),
    ...(req.params ? { params: req.params } : {}),
    ...(req.capabilities ? { capabilities: req.capabilities } : {}),
  };
  const priceKey = (profile.pricing ?? profile.model).toLowerCase();
  // A billed profile must end up with a resolvable price. Merge the inline price
  // (if any) before checking so "billed + inline price" is accepted (MJ2).
  const mergedPrices = req.price ? { ...existingPrices, [priceKey]: toFullPrice(req.price) } : existingPrices;
  if (billedProfileNeedsPrice(profile, mergedPrices)) {
    return { ok: false, error: `backend "${req.name}" is costMode:"billed" but has no price — supply a "price" or add config.prices["${priceKey}"]` };
  }
  // Non-fatal: a profile with no declared capabilities can't drive the in-process
  // lane's near-window compaction or reasoning round-trip — on a small-context or
  // local model it grows history unbounded and 400s with no recovery (m3). Warn
  // rather than reject (the claude lanes don't need capabilities). contextWindow is
  // schema-required once capabilities is present, so the only gap is omitting it.
  const warnings = req.capabilities
    ? undefined
    : [`backend "${req.name}" declares no "capabilities" — the in-process lane cannot compact near the context window; declare capabilities (incl. contextWindow) for a small-context or local model.`];
  return {
    ok: true,
    prepared: { name: req.name, profile, ...(req.price ? { priceKey, price: toFullPrice(req.price) } : {}) },
    ...(warnings ? { warnings } : {}),
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

// Auth header for a provider's /v1/models GET, chosen by wire dialect: openai-chat
// → Authorization: Bearer; anthropic → x-api-key (+ version). Keyless (no resolved
// key — e.g. a localhost proxy) → no auth header, mirroring the model clients.
function modelsAuthHeaders(dialect: string | undefined, apiKey: string | undefined): Record<string, string> {
  if (dialect === "anthropic") {
    return { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) };
  }
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

// A configured provider's available model ids for the two-level composer picker.
// A request-model lane (claude-cli/claude-sdk) shares the Claude catalog — no
// provider call. A profile-model lane (openai/anthropic-api/codex) fetches its
// provider's /v1/models with the resolved key + dialect auth header. Branches on
// the descriptor's DATA (modelSource/wireDialect), never a kind literal. fetch is
// injectable so the mapping + fail-soft paths are unit-tested with no billed call.
// FAIL-SOFT: any auth/network/parse failure returns the profile's pinned model
// alone plus an `error` — the picker never 500s.
export async function fetchBackendModels(opts: {
  profile: BackendProfile;
  descriptor: BackendDescriptor | null;
  claudeCatalogIds: () => Promise<string[]>;
  resolveAuth: (_auth: AuthRef | undefined) => Promise<ResolvedAuth>;
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
  try {
    const auth = await opts.resolveAuth(profile.auth);
    const resp = await doFetch(`${base}/v1/models`, { headers: modelsAuthHeaders(dialect, auth.apiKey) });
    if (!resp.ok) return { models: [profile.model], error: `provider returned HTTP ${resp.status}` };
    const data = (await resp.json()) as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(data?.data)
      ? data.data.map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return ids.length ? { models: ids } : { models: [profile.model], error: "provider returned no models" };
  } catch (e) {
    return { models: [profile.model], error: errMsg(e) };
  }
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
    });
    modelsCache.set(name, { at: now, result });
    writeJson(res, 200, result);
  });

  r.post("/api/backends", async ({ req, res }) => {
    const body = validate(AddBackendRequestSchema, await readBody(req));
    const result = validateAddBackend(body, c.config.prices);
    if (!result.ok) { writeJson(res, 400, { error: result.error }); return; }
    const { prepared } = result;
    for (const w of result.warnings ?? []) c.log.warn("add-backend", { warning: w });

    // Store the key in the Keychain by reference (keychain kinds only). The raw key
    // is then dropped — only auth:{kind,ref} reaches config.json.
    if (body.auth?.kind === "keychain" && body.auth.ref && body.apiKey) {
      try {
        writeKeychainSecret(body.auth.ref, body.apiKey);
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
