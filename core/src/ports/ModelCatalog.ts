// ModelCatalog — pricing + budget lookups by model SKU. Adapter is a thin
// wrapper around the daemon's CONFIG.prices.

import type { ModelCatalog as DomainModelCatalog, ModelPrice } from "../domain/value-objects.ts";

export type { DomainModelCatalog as ModelCatalog, ModelPrice };
