// Visual-answer media and geo routes (contracts/src/genui/spec.ts):
//   GET  /api/genui/media/img?src=    image proxy        ┐ ui-token: the dashboard's
//   GET  /api/genui/media/og?url=     page → og:image    │ <img>/MapLibre requests get
//   GET  /api/genui/media/icon?site=  domain → its icon  │ it from the app shell (host
//   GET  /api/genui/map/style.json    OpenFreeMap dark   │ views: their view token);
//   GET  /api/genui/map/t/<path>      tiles/glyphs/…     ┘ agents get no fetch proxy
//   GET  /api/genui/geocode?q=        Nominatim (1 rps, cached)
//   POST /api/genui/places            Overpass near a point (find_places)

import type { ServerResponse } from "node:http";

import type { Router, RouteContext } from "./Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import {
  GeocodeQuerySchema,
  MediaIconQuerySchema,
  MediaImgQuerySchema,
  MediaOgQuerySchema,
  PlacesRequestSchema,
} from "../../contracts/src/genui/spec.ts";
import { GeoServiceError, OSM_ATTRIBUTION } from "../../infra/src/genui/geo/NominatimGeocoder.ts";
import type { MediaBlob } from "../../infra/src/genui/GenuiMedia.ts";
import type { MapResponse } from "../../infra/src/genui/OpenFreeMapProxy.ts";
import type { GenuiMediaServices } from "../services/genui/media.ts";

export interface GenuiMediaRouteDeps {
  uiToken: string;
  genuiMedia: Pick<GenuiMediaServices, "media" | "map" | "geocoder" | "places">;
}

const DEFAULT_RADIUS_M = 1500;
const DEFAULT_LIMIT = 12;
// Served bytes are never a document: an SVG or a stray HTML answer opened
// directly can't run anything on the daemon's origin.
const INERT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
const MAP_TILE = new RegExp(`^${ROUTES.genuiMap}/t/(?<path>.+)$`);
const MAP_TYPES = /^(application\/json|application\/x-protobuf|application\/vnd\.mapbox-vector-tile|image\/(png|jpeg|webp))$/;

export function registerGenuiMediaRoutes(r: Router, c: GenuiMediaRouteDeps): void {
  const gated = (fn: (ctx: RouteContext) => Promise<void>) => async (ctx: RouteContext): Promise<void> => {
    if (isNavigation(ctx.req.headers["sec-fetch-dest"])) {
      writeJson(ctx.res, 403, { error: "not a page" });
      return;
    }
    if (!uiTokenOk(ctx.req, c.uiToken)) {
      writeJson(ctx.res, 403, { error: "ui token required" });
      return;
    }
    await fn(ctx);
  };
  const query = (url: URL): Record<string, string> => Object.fromEntries(url.searchParams);

  r.get(ROUTES.genuiMediaImg, gated(async (ctx) => {
    const q = validate(MediaImgQuerySchema, query(ctx.url));
    sendBlob(ctx, await c.genuiMedia.media.image(q.src));
  }));

  r.get(ROUTES.genuiMediaOg, gated(async (ctx) => {
    const q = validate(MediaOgQuerySchema, query(ctx.url));
    sendBlob(ctx, await c.genuiMedia.media.og(q.url));
  }));

  r.get(ROUTES.genuiMediaIcon, gated(async (ctx) => {
    const q = validate(MediaIconQuerySchema, query(ctx.url));
    sendBlob(ctx, await c.genuiMedia.media.icon(q.site));
  }));

  r.get(`${ROUTES.genuiMap}/style.json`, gated(async ({ res }) => {
    sendMap(res, await c.genuiMedia.map.style());
  }));

  r.get(MAP_TILE, gated(async ({ res, params }) => {
    sendMap(res, await c.genuiMedia.map.get(params.path ?? ""));
  }));

  r.get(ROUTES.genuiGeocode, async ({ url, res }) => {
    const q = validate(GeocodeQuerySchema, query(url));
    try {
      writeJson(res, 200, { results: await c.genuiMedia.geocoder.search(q.q, q.limit ?? 5), attribution: OSM_ATTRIBUTION });
    } catch (e) {
      if (!sendGeoError(res, e)) throw e;
    }
  });

  r.post(ROUTES.genuiPlaces, async ({ req, res }) => {
    const body = validate(PlacesRequestSchema, await readBody(req));
    try {
      let center: { lat: number; lon: number; label?: string };
      if ("text" in body.near) {
        const [hit] = await c.genuiMedia.geocoder.search(body.near.text, 1);
        if (!hit) {
          writeJson(res, 404, { error: `Couldn't find "${body.near.text}" on the map — try a fuller name (street, district, city).` });
          return;
        }
        center = { lat: hit.lat, lon: hit.lon, label: hit.label };
      } else {
        center = { lat: body.near.lat, lon: body.near.lon };
      }
      const radiusM = body.radiusM ?? DEFAULT_RADIUS_M;
      const places = await c.genuiMedia.places.search({
        query: body.query,
        category: body.category,
        center: { lat: center.lat, lon: center.lon },
        radiusM,
        limit: body.limit ?? DEFAULT_LIMIT,
      });
      writeJson(res, 200, { places, attribution: OSM_ATTRIBUTION, center, radiusM });
    } catch (e) {
      if (!sendGeoError(res, e)) throw e;
    }
  });
}

// A frame or window opened on the proxy (an app trying to carry data out in a
// query string) is refused before any fetch; <img>, fetch and workers pass.
const NAVIGATION_DESTS = new Set(["document", "iframe", "frame", "embed", "object"]);

export function isNavigation(dest: string | string[] | undefined): boolean {
  return typeof dest === "string" && NAVIGATION_DESTS.has(dest.toLowerCase());
}

function sendBlob({ req, res }: RouteContext, blob: MediaBlob | null): void {
  if (!blob) {
    res.setHeader("cache-control", "private, max-age=3600");
    writeJson(res, 404, { error: "no image" });
    return;
  }
  const headers: Record<string, string | number> = {
    "content-type": blob.contentType,
    "cache-control": "private, max-age=604800",
    etag: blob.etag,
    "x-content-type-options": "nosniff",
    "content-security-policy": INERT_CSP,
  };
  if (req.headers["if-none-match"] === blob.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "content-length": blob.body.length });
  res.end(blob.body);
}

function sendMap(res: ServerResponse, m: MapResponse): void {
  // Tiles come from one trusted host, but nothing it sends is served as a page here.
  res.writeHead(m.status, {
    "content-type": MAP_TYPES.test(m.contentType) ? m.contentType : "application/octet-stream",
    "content-length": m.body.length,
    "cache-control": m.cacheControl,
    "x-content-type-options": "nosniff",
    "content-security-policy": INERT_CSP,
  });
  res.end(m.body);
}

function sendGeoError(res: ServerResponse, e: unknown): boolean {
  if (!(e instanceof GeoServiceError)) return false;
  writeJson(res, 502, { error: e.message });
  return true;
}
