// Places near a point (Overpass in infra) — what find_places returns, already in
// the Place entity shape so a view can use them as they are.

import type { Place } from "../../../contracts/src/genui/catalog.ts";

export interface PlaceSearchQuery {
  readonly query?: string;
  readonly category?: string;
  readonly center: { readonly lat: number; readonly lon: number };
  readonly radiusM: number;
  readonly limit: number;
}

export interface PlaceSearch {
  search(q: PlaceSearchQuery): Promise<Place[]>;
}
