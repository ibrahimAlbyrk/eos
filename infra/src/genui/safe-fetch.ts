// An outbound GET for URLs an agent wrote (images, pages for og:image, site
// icons). The daemon runs on the user's Mac, so the guard is what keeps such a
// URL from reaching the LAN, loopback services or cloud metadata:
//   - http/https only, no credentials in the URL;
//   - the hostname is resolved by OUR lookup, every address checked, and the
//     socket connects to exactly those addresses (no DNS-rebinding window);
//   - each redirect (≤ 3) is a fresh, re-checked request;
//   - one deadline for the whole chain, a byte cap on the decoded body, and a
//     content-type check before the body is read.

import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { IncomingMessage, IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";

import { isBlockedAddress } from "./net-guard.ts";

export type SafeFetchErrorCode = "blocked" | "redirects" | "timeout" | "too-large" | "type" | "status" | "network";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  readonly status: number | null;
  constructor(code: SafeFetchErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeGetOptions {
  userAgent: string;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  // Checked on the response headers before any body byte is read.
  acceptType?: (contentType: string) => boolean;
  // Test seams.
  resolve?: Resolver;
  isBlocked?: (address: string) => boolean;
}

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type SafeGet = (url: string, opts: SafeGetOptions) => Promise<SafeResponse>;

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_REDIRECTS = 3;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

const systemResolve: Resolver = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

// Parses and vets a URL before any connection. Returns the URL or throws.
export function checkUrl(raw: string, isBlocked: (a: string) => boolean = isBlockedAddress): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError("blocked", `"${raw.slice(0, 80)}" is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SafeFetchError("blocked", `${u.protocol} URLs are not fetched — http(s) only`);
  if (u.username || u.password) throw new SafeFetchError("blocked", "URLs with credentials are not fetched");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SafeFetchError("blocked", "the URL has no host");
  if (isIP(host) && isBlocked(host)) throw new SafeFetchError("blocked", `${host} is a private or local address`);
  return u;
}

type ErrnoError = Error & { code?: string };
type LookupCallback = (err: ErrnoError | null, address: string | ResolvedAddress[], family?: number) => void;

// A net.connect lookup that resolves with `resolve` and refuses the whole host
// when any address is blocked — the socket then dials only what was checked.
export function guardedLookup(resolve: Resolver, isBlocked: (a: string) => boolean) {
  return (hostname: string, options: { family?: number | string; all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname).then(
      (all) => {
        const bad = all.find((a) => isBlocked(a.address));
        if (bad) {
          callback(new SafeFetchError("blocked", `${hostname} resolves to a private or local address (${bad.address})`) as ErrnoError, "");
          return;
        }
        const fam = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : Number(options.family) || 0;
        const list = fam ? all.filter((a) => a.family === fam) : all;
        if (!list.length) {
          const err = new Error(`${hostname} has no address`) as ErrnoError;
          err.code = "ENOTFOUND";
          callback(err, "");
          return;
        }
        if (options.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      },
      (e: unknown) => callback((e instanceof Error ? e : new Error(String(e))) as ErrnoError, ""),
    );
  };
}

export const safeGet: SafeGet = async (raw, opts) => {
  const isBlocked = opts.isBlocked ?? isBlockedAddress;
  const lookup = guardedLookup(opts.resolve ?? systemResolve, isBlocked);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_REDIRECTS;
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    let url = checkUrl(raw, isBlocked);
    for (let hop = 0; ; hop++) {
      const res = await request(url, opts, lookup, ac.signal);
      if (REDIRECT.has(res.statusCode ?? 0) && res.headers.location) {
        res.destroy();
        if (hop >= maxRedirects) throw new SafeFetchError("redirects", `more than ${maxRedirects} redirects`);
        let next: string;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          throw new SafeFetchError("network", "the redirect target is not a URL");
        }
        url = checkUrl(next, isBlocked);
        continue;
      }
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.destroy();
        throw new SafeFetchError("status", `the server answered ${status}`, status);
      }
      const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (opts.acceptType && !opts.acceptType(contentType)) {
        res.destroy();
        throw new SafeFetchError("type", `${contentType || "a response without a type"} is not what was asked for`);
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        res.destroy();
        throw new SafeFetchError("too-large", `${declared} bytes, max ${opts.maxBytes}`);
      }
      const body = await readCapped(res, opts.maxBytes);
      return { url: url.toString(), status, contentType, headers: res.headers, body };
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    if (ac.signal.aborted) throw new SafeFetchError("timeout", `no answer within ${Math.round(timeoutMs / 1000)} s`);
    // The lookup's refusal can arrive wrapped by the socket layer.
    const cause = (e as { cause?: unknown })?.cause;
    if (cause instanceof SafeFetchError) throw cause;
    throw new SafeFetchError("network", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
};

function request(
  url: URL,
  opts: SafeGetOptions,
  lookup: ReturnType<typeof guardedLookup>,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: "GET",
      agent: false,
      lookup: lookup as unknown as http.RequestOptions["lookup"],
      signal,
      headers: {
        "user-agent": opts.userAgent,
        accept: opts.accept ?? "*/*",
        "accept-encoding": "gzip, deflate, br",
      },
    });
    req.on("response", resolve);
    req.on("error", reject);
    req.end();
  });
}

function decoded(res: IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(createGunzip());
  if (enc === "deflate") return res.pipe(createInflate());
  if (enc === "br") return res.pipe(createBrotliDecompress());
  return res;
}

// Reads the (decoded) body, stopping the moment it passes the cap — a small
// compressed response can't expand past it either.
function readCapped(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = decoded(res);
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: Error): void => {
      if (done) return;
      done = true;
      res.destroy();
      if (stream !== res) stream.destroy();
      reject(e);
    };
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new SafeFetchError("too-large", `more than ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
    res.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
    res.on("aborted", () => fail(new Error("the response was cut off")));
  });
}
