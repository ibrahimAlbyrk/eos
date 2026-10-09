// Place names ↔ coordinates (Nominatim in infra: rate-limited, cached). Results
// carry OpenStreetMap data — show its attribution wherever they appear.

import type { Area, GeocodeResult } from "../../../contracts/src/genui/spec.ts";

export interface Geocoder {
  search(q: string, limit?: number): Promise<GeocodeResult[]>;
  // The district / city / country around a point; null when unknown.
  reverse(lat: number, lon: number): Promise<Area | null>;
}
