// The map behind visual answers: OpenFreeMap's `dark` style, its TileJSON,
// tiles, glyphs and sprites, fetched on demand through the daemon. Only
// https://tiles.openfreemap.org is ever contacted. JSON documents (the style,
// TileJSON) come back with every OpenFreeMap URL rewritten to the proxy path,
// so the map keeps asking the daemon. No prefetch — OpenFreeMap's terms ask
// for on-demand use. Swapping providers (a self-hosted Protomaps extract) is a
// change here only.

export const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";
export const OPENFREEMAP_STYLE_PATH = "styles/dark";
export const MAP_ATTRIBUTION = "OpenFreeMap © OpenMapTiles Data from OpenStreetMap";
// Where the dashboard reaches the proxy; MapLibre's transformRequest prefixes
// the daemon base (which is /h/<host>/… inside a controlled computer's view).
export const MAP_PROXY_PREFIX = "/api/genui/map/t";

const MAX_BYTES = 8 * 1024 * 1024;
const JSON_TTL_MS = 60 * 60 * 1000;
const JSON_MAX_ENTRIES = 32;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

export interface MapResponse {
  status: number;
  contentType: string;
  body: Buffer;
  cacheControl: string;
}

export type MapFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" }) => Promise<Response>;

// Every string starting with the OpenFreeMap origin, anywhere in a JSON value,
// is pointed at `prefix` (tile templates keep their {z}/{x}/{y} placeholders).
export function rewriteMapUrls(value: unknown, prefix: string = MAP_PROXY_PREFIX): unknown {
  if (typeof value === "string") {
    return value.startsWith(`${OPENFREEMAP_ORIGIN}/`) ? `${prefix}/${value.slice(OPENFREEMAP_ORIGIN.length + 1)}` : value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteMapUrls(v, prefix));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__") continue;
      out[k] = rewriteMapUrls(v, prefix);
    }
    return out;
  }
  return value;
}

// The upstream URL for a proxied path, or null when it would leave OpenFreeMap
// (an absolute URL, a scheme-relative one, a dot segment, a stray character).
export function upstreamUrl(path: string): string | null {
  if (!path || path.length > 512) return null;
  if (!/^[A-Za-z0-9_.~%@,+{}-][A-Za-z0-9_.~%@,+{}/ -]*$/.test(path)) return null;
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes("..") || decoded.includes("\\") || decoded.startsWith("/")) return null;
  const u = new URL(`${OPENFREEMAP_ORIGIN}/${path}`);
  return u.origin === OPENFREEMAP_ORIGIN ? u.toString() : null;
}

export class OpenFreeMapProxy {
  private readonly fetch: MapFetch;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly json = new Map<string, { at: number; res: MapResponse }>();
  private readonly inflight = new Map<string, Promise<MapResponse>>();

  constructor(opts: { userAgent: string; now: () => number; fetch?: MapFetch; prefix?: string }) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.userAgent = opts.userAgent;
    this.now = opts.now;
    this.prefix = opts.prefix ?? MAP_PROXY_PREFIX;
  }

  style(): Promise<MapResponse> {
    return this.get(OPENFREEMAP_STYLE_PATH);
  }

  // A path under the OpenFreeMap origin: tiles, TileJSON, glyphs, sprites.
  get(path: string): Promise<MapResponse> {
    const url = upstreamUrl(path);
    if (!url) return Promise.resolve(notFound("not an OpenFreeMap path"));
    const cached = this.json.get(url);
    if (cached && this.now() - cached.at < JSON_TTL_MS) return Promise.resolve(cached.res);
    const flying = this.inflight.get(url);
    if (flying) return flying;
    const p = this.load(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async load(url: string): Promise<MapResponse> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      let target = url;
      for (let hop = 0; ; hop++) {
        const res = await this.fetch(target, { headers: { "user-agent": this.userAgent }, signal: ac.signal, redirect: "manual" });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          const next = loc ? new URL(loc, target) : null;
          if (!next || next.origin !== OPENFREEMAP_ORIGIN || hop >= MAX_REDIRECTS) return upstreamFailed(`redirect to ${next?.origin ?? "nowhere"}`);
          target = next.toString();
          continue;
        }
        if (res.status === 404 || res.status === 204) return notFound("no such map resource");
        if (!res.ok) return upstreamFailed(`OpenFreeMap answered ${res.status}`);
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_BYTES) return upstreamFailed("response too large");
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > MAX_BYTES) return upstreamFailed("response too large");
        const contentType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
        if (contentType.includes("json") || url.endsWith(OPENFREEMAP_STYLE_PATH)) {
          return this.rewriteJson(url, body);
        }
        // Tile, glyph and sprite URLs are versioned upstream, so they keep.
        return { status: 200, contentType, body, cacheControl: "private, max-age=604800" };
      }
    } catch (e) {
      return upstreamFailed(ac.signal.aborted ? "OpenFreeMap timed out" : e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  private rewriteJson(url: string, body: Buffer): MapResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return upstreamFailed("OpenFreeMap sent invalid JSON");
    }
    const rewritten = rewriteMapUrls(parsed, this.prefix) as Record<string, unknown>;
    if (url.endsWith(OPENFREEMAP_STYLE_PATH) && rewritten && typeof rewritten === "object" && !Array.isArray(rewritten)) {
      const meta = rewritten.metadata && typeof rewritten.metadata === "object" ? (rewritten.metadata as Record<string, unknown>) : {};
      rewritten.metadata = { ...meta, "eos:attribution": MAP_ATTRIBUTION };
    }
    const res: MapResponse = {
      status: 200,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(rewritten)),
      cacheControl: "private, max-age=3600",
    };
    this.json.set(url, { at: this.now(), res });
    if (this.json.size > JSON_MAX_ENTRIES) this.json.delete(this.json.keys().next().value as string);
    return res;
  }
}

function notFound(reason: string): MapResponse {
  return { status: 404, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: reason })), cacheControl: "private, max-age=300" };
}

function upstreamFailed(reason: string): MapResponse {
  return { status: 502, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: reason })), cacheControl: "no-store" };
}
