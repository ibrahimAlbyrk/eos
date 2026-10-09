// Images for visual answers, fetched on the daemon so the dashboard never
// talks to arbitrary hosts and an agent-written URL never reaches the LAN:
//   image(src)   an image URL           → the image
//   og(url)      a page URL             → its og:image / twitter:image
//   icon(site)   a domain               → its apple-touch-icon / icon / favicon
// Every fetch goes through safeGet's guard, results (and failures, briefly) are
// cached on disk, and concurrent asks for the same thing share one fetch.

import { createHash } from "node:crypto";

import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { MediaFetcher } from "../../../core/src/ports/MediaFetcher.ts";
import { MediaCache, cacheKey, type CacheMeta } from "./MediaCache.ts";
import { extractIcons, extractPreviewImage, normalizeSite } from "./html-meta.ts";
import { SafeFetchError, safeGet as defaultSafeGet, type SafeGet, type SafeGetOptions } from "./safe-fetch.ts";

export const MEDIA_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_PAGE_MAX_BYTES = 1024 * 1024;
const ICON_TRIES = 4;

export interface MediaBlob {
  contentType: string;
  body: Buffer;
  etag: string;
  fetchedAt: number;
}

const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8";
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

// Types a server sends for bytes that may still be an image; sniffed afterwards.
const OPAQUE_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/binary", "application/unknown"]);

export function isImageish(contentType: string): boolean {
  return contentType.startsWith("image/") || OPAQUE_TYPES.has(contentType);
}

// The image type from the first bytes, or null when they aren't an image Eos serves.
export function sniffImageType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp" && /^avi[fs]$/.test(b.subarray(8, 12).toString("latin1"))) return "image/avif";
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  const head = b.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

// The served type: a declared image type is kept (nosniff on the way out),
// anything opaque must sniff as an image.
export function imageTypeOf(declared: string, body: Buffer): string | null {
  if (declared.startsWith("image/")) return declared;
  return sniffImageType(body);
}

function etagOf(body: Buffer): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

export class GenuiMedia implements MediaFetcher {
  private readonly cache: MediaCache;
  private readonly clock: Clock;
  private readonly log: Logger | null;
  private readonly get: SafeGet;
  private readonly base: Pick<SafeGetOptions, "userAgent" | "timeoutMs" | "resolve" | "isBlocked">;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: {
    cache: MediaCache;
    clock: Clock;
    userAgent: string;
    log?: Logger;
    timeoutMs?: number;
    // Test seams.
    safeGet?: SafeGet;
    resolve?: SafeGetOptions["resolve"];
    isBlocked?: SafeGetOptions["isBlocked"];
  }) {
    this.cache = opts.cache;
    this.clock = opts.clock;
    this.log = opts.log ?? null;
    this.get = opts.safeGet ?? defaultSafeGet;
    this.base = { userAgent: opts.userAgent, timeoutMs: opts.timeoutMs, resolve: opts.resolve, isBlocked: opts.isBlocked };
  }

  image(src: string): Promise<MediaBlob | null> {
    const key = cacheKey("img", src);
    return this.once(key, async () => {
      const hit = await this.cache.get(key);
      if (hit?.meta.kind === "blob" && hit.body) {
        return { contentType: hit.meta.contentType, body: hit.body, etag: etagOf(hit.body), fetchedAt: hit.meta.fetchedAt };
      }
      if (hit?.meta.kind === "miss") return null;
      try {
        const res = await this.get(src, { ...this.base, maxBytes: MEDIA_IMAGE_MAX_BYTES, accept: IMAGE_ACCEPT, acceptType: isImageish });
        const contentType = imageTypeOf(res.contentType, res.body);
        if (!contentType || res.body.length === 0) throw new SafeFetchError("type", "the response is not an image");
        const fetchedAt = this.clock.now();
        await this.store(key, { url: src, kind: "blob", contentType, size: res.body.length, fetchedAt }, res.body);
        return { contentType, body: res.body, etag: etagOf(res.body), fetchedAt };
      } catch (e) {
        await this.remember(key, src, e);
        return null;
      }
    });
  }

  og(pageUrl: string): Promise<MediaBlob | null> {
    return this.viaRef(cacheKey("og", pageUrl), pageUrl, async () => {
      const page = await this.page(pageUrl);
      return page ? extractPreviewImage(page.html, page.url) : null;
    });
  }

  icon(site: string): Promise<MediaBlob | null> {
    const host = normalizeSite(site);
    if (!host) return Promise.resolve(null);
    const key = cacheKey("icon", host);
    return this.once(key, async () => {
      const hit = await this.cache.get(key);
      if (hit?.meta.kind === "ref" && hit.meta.ref) return this.image(hit.meta.ref);
      if (hit?.meta.kind === "miss") return null;
      const home = `https://${host}/`;
      let page = await this.page(home);
      if (!page && !host.startsWith("www.")) page = await this.page(`https://www.${host}/`);
      const candidates = page
        ? extractIcons(page.html, page.url)
        : [...extractIcons("", home), ...(host.startsWith("www.") ? [] : extractIcons("", `https://www.${host}/`))];
      for (const url of candidates.slice(0, ICON_TRIES)) {
        const img = await this.image(url);
        if (img) {
          await this.store(key, { url: host, kind: "ref", contentType: "", size: 0, fetchedAt: this.clock.now(), ref: url });
          return img;
        }
      }
      await this.store(key, { url: host, kind: "miss", contentType: "", size: 0, fetchedAt: this.clock.now(), reason: "no icon" });
      return null;
    });
  }

  // A page whose image is resolved once: the resolved URL is cached as a ref
  // (the image under its own key); "nothing found" only as a short-lived miss,
  // since a page that didn't answer may answer later.
  private viaRef(key: string, url: string, resolve: () => Promise<string | null>): Promise<MediaBlob | null> {
    return this.once(key, async () => {
      const hit = await this.cache.get(key);
      if (hit?.meta.kind === "ref" && hit.meta.ref) return this.image(hit.meta.ref);
      if (hit?.meta.kind === "miss") return null;
      const ref = await resolve();
      if (!ref) {
        await this.store(key, { url, kind: "miss", contentType: "", size: 0, fetchedAt: this.clock.now(), reason: "no preview image" });
        return null;
      }
      await this.store(key, { url, kind: "ref", contentType: "", size: 0, fetchedAt: this.clock.now(), ref });
      return this.image(ref);
    });
  }

  private async page(url: string): Promise<{ url: string; html: string } | null> {
    try {
      const res = await this.get(url, {
        ...this.base,
        maxBytes: MEDIA_PAGE_MAX_BYTES,
        accept: HTML_ACCEPT,
        acceptType: (t) => t === "" || t === "text/html" || t === "application/xhtml+xml",
      });
      return { url: res.url, html: res.body.toString("utf8") };
    } catch (e) {
      this.log?.debug("genui media: page fetch failed", { url, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  private async remember(key: string, url: string, e: unknown): Promise<void> {
    const reason = e instanceof Error ? e.message : String(e);
    this.log?.debug("genui media: image fetch failed", { url, error: reason });
    await this.store(key, { url, kind: "miss", contentType: "", size: 0, fetchedAt: this.clock.now(), reason });
  }

  private async store(key: string, meta: CacheMeta, body: Buffer | null = null): Promise<void> {
    try {
      await this.cache.put(key, meta, body);
    } catch (e) {
      // A full or read-only disk only costs a refetch.
      this.log?.warn("genui media: cache write failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const flying = this.inflight.get(key) as Promise<T> | undefined;
    if (flying) return flying;
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
