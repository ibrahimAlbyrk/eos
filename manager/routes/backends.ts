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
import { AddBackendRequestSchema, type AddBackendRequest } from "../../contracts/src/http.ts";
import type { BackendProfile } from "../../contracts/src/backend.ts";
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
): { ok: true; prepared: PreparedBackend } | { ok: false; error: string } {
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
  return {
    ok: true,
    prepared: { name: req.name, profile, ...(req.price ? { priceKey, price: toFullPrice(req.price) } : {}) },
  };
}

// The UI price shape (in/out/cacheRead/cacheCreate) → the config ModelPrice
// (adds cacheCreate1h). Missing cache fields default to 0 for a new provider.
function toFullPrice(p: { in: number; out: number; cacheRead: number; cacheCreate: number }): ModelPrice {
  return { in: p.in, out: p.out, cacheRead: p.cacheRead, cacheCreate: p.cacheCreate, cacheCreate1h: p.cacheCreate * 2 };
}

export function registerBackendsRoutes(r: Router, c: Container): void {
  r.post("/api/backends", async ({ req, res }) => {
    const body = validate(AddBackendRequestSchema, await readBody(req));
    const result = validateAddBackend(body, c.config.prices);
    if (!result.ok) { writeJson(res, 400, { error: result.error }); return; }
    const { prepared } = result;

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
