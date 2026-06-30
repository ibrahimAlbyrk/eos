// ModelPricingCatalog — resolves a model id to its CURRENT per-MILLION-token
// ModelPrice from a maintained cross-provider pricing source, so adding a provider
// needs only its API key (no manual per-model price entry). lookup is SYNC against
// an in-memory index — the cost-ledger hot path can't await; the adapter refreshes
// that index in the background. Returns null when the model is unknown to the
// catalog: the caller decides the fallback (config.prices override wins → catalog →
// loud known-zero).

import type { ModelPrice } from "../domain/value-objects.ts";

export interface ModelPricingCatalog {
  lookup(model: string | null | undefined): ModelPrice | null;
}
