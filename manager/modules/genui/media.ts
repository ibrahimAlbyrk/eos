// Composition of the visual-answer media + geo adapters, and the location
// source. Everything here caches under ~/.eos/media-cache (regenerable — not
// listed in shared/user-data.ts): images and resolved refs at the top level,
// geocoder / place answers under geo/.

import { join } from "node:path";

import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { LocationSource } from "../../../core/src/ports/LocationSource.ts";
import { GENUI_SETTING_DEFAULTS, GENUI_SETTING_KEYS, LocationFixSchema, type LocationResponse } from "../../../contracts/src/genui/spec.ts";
import { GenuiMedia } from "../../../infra/src/genui/GenuiMedia.ts";
import { MediaCache } from "../../../infra/src/genui/MediaCache.ts";
import { OpenFreeMapProxy } from "../../../infra/src/genui/OpenFreeMapProxy.ts";
import { JsonTtlStore } from "../../../infra/src/genui/geo/JsonTtlStore.ts";
import { NominatimGeocoder } from "../../../infra/src/genui/geo/NominatimGeocoder.ts";
import { OverpassPlaceSearch } from "../../../infra/src/genui/geo/OverpassPlaceSearch.ts";

export const MEDIA_CACHE_DIR = "media-cache";
const AREA_TIMEOUT_MS = 5000;

export type LocationErrorCode = "sharing-off" | "app-offline" | "denied" | "disabled" | "unavailable" | "timeout" | "unsupported";

const LOCATION_STATUS: Record<LocationErrorCode, number> = {
  "sharing-off": 403,
  "app-offline": 503,
  denied: 403,
  disabled: 403,
  unavailable: 503,
  timeout: 504,
  unsupported: 503,
};

const LOCATION_TEXT: Record<LocationErrorCode, string> = {
  "sharing-off": "Location sharing is off. The user can turn it on in Settings › General › Visual answers.",
  "app-offline": "The Eos app isn't running, so this Mac's location can't be read right now.",
  denied: "macOS hasn't given Eos location access. The user can allow it in System Settings › Privacy & Security › Location Services (or press Test in Settings › General › Visual answers).",
  disabled: "Location Services are turned off on this Mac. The user can turn them on in System Settings › Privacy & Security › Location Services.",
  unavailable: "This Mac couldn't work out where it is right now (no Wi-Fi location fix).",
  timeout: "macOS didn't return a location in time. If a location prompt is open, the user should allow it, then try again.",
  unsupported: "This version of the Eos app can't read the location.",
};

export class LocationError extends Error {
  readonly code: LocationErrorCode;
  readonly status: number;
  constructor(code: LocationErrorCode, detail?: string) {
    super(detail ? `${LOCATION_TEXT[code]} (${detail})` : LOCATION_TEXT[code]);
    this.name = "LocationError";
    this.code = code;
    this.status = LOCATION_STATUS[code];
  }
}

// The app's location.get RPC rejects with one of these names (app/src/main/location.ts).
const APP_ERROR: Record<string, LocationErrorCode> = {
  LocationDenied: "denied",
  LocationDisabled: "disabled",
  LocationUnavailable: "unavailable",
  LocationTimeout: "timeout",
  LocationUnsupported: "unsupported",
};

export interface AppHostLike {
  isRegistered(): boolean;
  rpc(sessionKey: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface SettingsReader {
  read(): Record<string, unknown>;
}

export interface GenuiMediaDeps {
  home: string;
  clock: Clock;
  log: Logger;
  appHost: AppHostLike;
  userSettings: SettingsReader;
  // Part of the shared wiring signature; nothing here reads config today.
  config?: unknown;
  version?: string;
}

export interface GenuiMediaServices {
  media: GenuiMedia;
  map: OpenFreeMapProxy;
  geocoder: NominatimGeocoder;
  places: OverpassPlaceSearch;
  location: LocationSource;
}

export function genuiUserAgent(version = "1"): string {
  return `Eos/${version} (+local desktop app)`;
}

export function buildGenuiMedia(deps: GenuiMediaDeps): GenuiMediaServices {
  const dir = join(deps.home, MEDIA_CACHE_DIR);
  const userAgent = genuiUserAgent(deps.version);
  const log = deps.log.child({ svc: "genui-media" });
  const media = new GenuiMedia({ cache: new MediaCache({ dir, clock: deps.clock }), clock: deps.clock, userAgent, log });
  const map = new OpenFreeMapProxy({ userAgent, now: () => deps.clock.now() });
  const geocoder = new NominatimGeocoder({
    store: new JsonTtlStore({ file: join(dir, "geo", "nominatim.json"), clock: deps.clock, maxEntries: 2000 }),
    clock: deps.clock,
    userAgent,
  });
  const places = new OverpassPlaceSearch({
    store: new JsonTtlStore({ file: join(dir, "geo", "overpass.json"), clock: deps.clock, maxEntries: 60 }),
    userAgent,
  });
  const location = makeLocationSource({ appHost: deps.appHost, userSettings: deps.userSettings, geocoder, log });
  return { media, map, geocoder, places, location };
}

export function locationSharingOn(settings: SettingsReader): boolean {
  const v = settings.read()[GENUI_SETTING_KEYS.locationShare];
  return typeof v === "boolean" ? v : GENUI_SETTING_DEFAULTS.locationShare;
}

export function makeLocationSource(deps: {
  appHost: AppHostLike;
  userSettings: SettingsReader;
  geocoder: Pick<NominatimGeocoder, "reverse">;
  log?: Logger;
}): LocationSource {
  return {
    sharing: () => locationSharingOn(deps.userSettings),
    connected: () => deps.appHost.isRegistered(),
    async current(): Promise<LocationResponse> {
      if (!locationSharingOn(deps.userSettings)) throw new LocationError("sharing-off");
      if (!deps.appHost.isRegistered()) throw new LocationError("app-offline");
      let raw: unknown;
      try {
        raw = await deps.appHost.rpc("", "location.get", []);
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        const code = APP_ERROR[name];
        if (code) throw new LocationError(code);
        const msg = e instanceof Error ? e.message : String(e);
        if (/not connected|disconnected/i.test(msg)) throw new LocationError("app-offline");
        // An app that predates location.get answers with its driver's "unknown method".
        if (/unknown|unsupported|not a function/i.test(msg)) throw new LocationError("unsupported", msg);
        throw new LocationError("unavailable", msg);
      }
      const fix = LocationFixSchema.safeParse(raw);
      if (!fix.success) throw new LocationError("unsupported", "the app sent no coordinates");
      const area = await withTimeout(deps.geocoder.reverse(fix.data.lat, fix.data.lon), AREA_TIMEOUT_MS).catch((e: unknown) => {
        deps.log?.debug("location: reverse geocode failed", { error: e instanceof Error ? e.message : String(e) });
        return null;
      });
      return area ? { ...fix.data, area } : fix.data;
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
