import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MediaCache, cacheKey } from "../genui/MediaCache.ts";
import { GenuiMedia, sniffImageType } from "../genui/GenuiMedia.ts";
import { extractIcons, extractPreviewImage, normalizeSite } from "../genui/html-meta.ts";
import { SafeFetchError, type SafeGet, type SafeResponse } from "../genui/safe-fetch.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const tmp = () => mkdtempSync(join(tmpdir(), "eos-media-"));

function clockAt(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function blobMeta(url: string, size: number, at: number) {
  return { url, kind: "blob" as const, contentType: "image/png", size, fetchedAt: at };
}

describe("MediaCache", () => {
  it("round-trips a blob and expires it after the TTL", async () => {
    const clock = clockAt();
    const cache = new MediaCache({ dir: tmp(), clock, ttlMs: 1000 });
    const key = cacheKey("img", "https://a.example/x.png");
    await cache.put(key, blobMeta("https://a.example/x.png", PNG.length, clock.now()), PNG);
    const hit = await cache.get(key);
    assert.deepEqual(hit?.body, PNG);
    assert.equal(hit?.meta.contentType, "image/png");
    clock.advance(1001);
    assert.equal(await cache.get(key), null);
    assert.equal(cache.totalBytes, 0);
  });

  it("forgets a miss sooner than a hit", async () => {
    const clock = clockAt();
    const cache = new MediaCache({ dir: tmp(), clock, ttlMs: 10_000, missTtlMs: 100 });
    const key = cacheKey("img", "u");
    await cache.put(key, { url: "u", kind: "miss", contentType: "", size: 0, fetchedAt: clock.now() });
    assert.equal((await cache.get(key))?.meta.kind, "miss");
    clock.advance(101);
    assert.equal(await cache.get(key), null);
  });

  it("evicts the least recently used past the byte cap", async () => {
    const clock = clockAt();
    const dir = tmp();
    const cache = new MediaCache({ dir, clock, maxBytes: 2500 });
    const body = Buffer.alloc(1000, 1);
    const [a, b, c] = ["a", "b", "c"].map((n) => cacheKey("img", n));
    await cache.put(a, blobMeta("a", 1000, clock.now()), body);
    clock.advance(10);
    await cache.put(b, blobMeta("b", 1000, clock.now()), body);
    clock.advance(10);
    assert.ok(await cache.get(a)); // a is now fresher than b
    clock.advance(10);
    await cache.put(c, blobMeta("c", 1000, clock.now()), body);
    assert.ok(await cache.get(a));
    assert.equal(await cache.get(b), null);
    assert.ok(await cache.get(c));
    assert.ok(cache.totalBytes <= 2500);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith(b)).length, 0);
  });

  it("rebuilds its index from disk and drops half-written files", async () => {
    const clock = clockAt();
    const dir = tmp();
    const first = new MediaCache({ dir, clock });
    const key = cacheKey("img", "persist");
    await first.put(key, blobMeta("persist", PNG.length, clock.now()), PNG);
    const again = new MediaCache({ dir, clock });
    assert.deepEqual((await again.get(key))?.body, PNG);
    assert.ok(again.totalBytes >= PNG.length);
  });
});

function fakeGet(routes: Record<string, Partial<SafeResponse> | Error>) {
  const calls: string[] = [];
  const get: SafeGet = async (url, opts) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new SafeFetchError("status", "404", 404);
    if (r instanceof Error) throw r;
    const contentType = r.contentType ?? "image/png";
    if (opts.acceptType && !opts.acceptType(contentType)) throw new SafeFetchError("type", `${contentType}`);
    await new Promise((res) => setTimeout(res, 5));
    return { url: r.url ?? url, status: 200, contentType, headers: {}, body: r.body ?? PNG };
  };
  return { get, calls };
}

describe("GenuiMedia", () => {
  const make = (routes: Record<string, Partial<SafeResponse> | Error>) => {
    const clock = clockAt();
    const { get, calls } = fakeGet(routes);
    const media = new GenuiMedia({ cache: new MediaCache({ dir: tmp(), clock }), clock, userAgent: "Eos/test", safeGet: get });
    return { media, calls, clock };
  };

  it("shares one fetch between concurrent asks and caches the result", async () => {
    const { media, calls } = make({ "https://cdn.example/a.png": {} });
    const [x, y] = await Promise.all([media.image("https://cdn.example/a.png"), media.image("https://cdn.example/a.png")]);
    assert.ok(x && y);
    assert.equal(x.contentType, "image/png");
    assert.equal(calls.length, 1);
    await media.image("https://cdn.example/a.png");
    assert.equal(calls.length, 1, "served from disk");
  });

  it("refuses bytes that aren't an image, and remembers the miss", async () => {
    const { media, calls } = make({ "https://cdn.example/fake.png": { contentType: "application/octet-stream", body: Buffer.from("<html>") } });
    assert.equal(await media.image("https://cdn.example/fake.png"), null);
    assert.equal(await media.image("https://cdn.example/fake.png"), null);
    assert.equal(calls.length, 1);
  });

  it("sniffs an image sent as octet-stream", async () => {
    const { media } = make({ "https://cdn.example/b": { contentType: "application/octet-stream" } });
    assert.equal((await media.image("https://cdn.example/b"))?.contentType, "image/png");
  });

  it("resolves a page's og:image relative to the final URL", async () => {
    const html = `<html><head><meta property="og:image" content="/media/hero.jpg"><title>x</title></head><body></body></html>`;
    const { media, calls } = make({
      "https://shop.example/item": { contentType: "text/html", body: Buffer.from(html), url: "https://www.shop.example/item/1" },
      "https://www.shop.example/media/hero.jpg": { contentType: "image/jpeg" },
    });
    const img = await media.og("https://shop.example/item");
    assert.equal(img?.contentType, "image/jpeg");
    await media.og("https://shop.example/item");
    assert.deepEqual(calls, ["https://shop.example/item", "https://www.shop.example/media/hero.jpg"]);
  });

  it("finds a site's best icon and falls back to /favicon.ico", async () => {
    const html = `<link rel="icon" href="/fav-16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180">`;
    const { media, calls } = make({
      "https://acme.example/": { contentType: "text/html", body: Buffer.from(html) },
      "https://acme.example/touch.png": {},
    });
    assert.ok(await media.icon("https://Acme.example/about"));
    assert.equal(calls[1], "https://acme.example/touch.png");

    const bare = make({ "https://www.plain.example/favicon.ico": { contentType: "image/x-icon" } });
    assert.equal((await bare.media.icon("plain.example"))?.contentType, "image/x-icon");
    assert.deepEqual(bare.calls.slice(0, 2), ["https://plain.example/", "https://www.plain.example/"]);
  });

  it("answers null for a site that isn't a domain", async () => {
    const { media, calls } = make({});
    assert.equal(await media.icon("localhost"), null);
    assert.equal(await media.icon("10.0.0.1"), null);
    assert.equal(calls.length, 0);
  });
});

describe("html-meta", () => {
  it("prefers og:image:secure_url, then og:image, then twitter:image", () => {
    const page = "https://news.example/a/b";
    assert.equal(
      extractPreviewImage(`<meta name="twitter:image" content="https://t.example/t.jpg"><meta property='og:image' content='img/o.jpg'>`, page),
      "https://news.example/a/img/o.jpg",
    );
    assert.equal(extractPreviewImage(`<meta name="twitter:image" content="https://t.example/t.jpg">`, page), "https://t.example/t.jpg");
    assert.equal(extractPreviewImage(`<meta property="og:image" content="javascript:alert(1)">`, page), null);
    assert.equal(extractPreviewImage(`<head></head><body><meta property="og:image" content="/late.jpg"></body>`, page), null);
    assert.equal(extractPreviewImage(`<meta property="og:image" content="/a.jpg?x=1&amp;y=2">`, page), "https://news.example/a.jpg?x=1&y=2");
  });

  it("orders icons best first with root fallbacks", () => {
    const icons = extractIcons(`<link rel="shortcut icon" href="/f.ico"><link rel="icon" type="image/svg+xml" href="/i.svg"><link rel="apple-touch-icon" href="/t.png">`, "https://x.example/p");
    assert.deepEqual(icons, [
      "https://x.example/t.png",
      "https://x.example/i.svg",
      "https://x.example/f.ico",
      "https://x.example/apple-touch-icon.png",
      "https://x.example/favicon.ico",
    ]);
  });

  it("normalizes sites", () => {
    assert.equal(normalizeSite("Example.COM"), "example.com");
    assert.equal(normalizeSite("https://www.example.co.uk/menu?x"), "www.example.co.uk");
    assert.equal(normalizeSite("bücher.de"), "xn--bcher-kva.de");
    assert.equal(normalizeSite("localhost"), null);
    assert.equal(normalizeSite("192.168.1.1"), null);
    assert.equal(normalizeSite("ftp://x"), null);
  });

  it("sniffs image types", () => {
    assert.equal(sniffImageType(PNG), "image/png");
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImageType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), "image/svg+xml");
    assert.equal(sniffImageType(Buffer.from("<html><svg></svg></html>")), null);
  });
});
