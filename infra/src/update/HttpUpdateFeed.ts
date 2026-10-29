// The update feed over HTTPS: a signed pointer per platform, the manifests it
// names and byte ranges of the packs. Transient failures (no network, a 5xx, a
// rate limit) are retried a few times with backoff; everything is size-capped
// before it is read, and the manifest is checked against the pointer's hash.

import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";

import {
  SignedUpdatePointerSchema, UpdateManifestSchema,
  type SignedUpdatePointer, type UpdateManifest, type UpdatePlatform, type UpdatePointer,
} from "../../../contracts/src/update.ts";
import { UpdateError } from "../../../core/src/domain/update/errors.ts";
import type { UpdateFeed } from "../../../core/src/ports/Updates.ts";

const POINTER_MAX_BYTES = 32 * 1024;
// A manifest unpacks to well under this (the 567 MB bundle's is ~2 MB).
const MANIFEST_MAX_UNPACKED = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const BACKOFF_MS = [1_000, 4_000, 10_000];

export interface HttpUpdateFeedDeps {
  // Read on every request: the pointer may move the feed (feedUrl).
  readonly baseUrl: () => string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class HttpUpdateFeed implements UpdateFeed {
  private readonly deps: HttpUpdateFeedDeps;

  constructor(deps: HttpUpdateFeedDeps) {
    this.deps = deps;
  }

  async pointer(platform: UpdatePlatform): Promise<SignedUpdatePointer | null> {
    const res = await this.get(`stable/${platform}.json`, { optional: true });
    if (!res) return null;
    const parsed = SignedUpdatePointerSchema.safeParse(parseJson(await readCapped(res, POINTER_MAX_BYTES)));
    if (!parsed.success) throw new UpdateError("bad-release", "the release pointer is malformed");
    return parsed.data;
  }

  async manifest(ref: UpdatePointer["manifest"]): Promise<UpdateManifest> {
    const res = await this.get(ref.path);
    const packed = await readCapped(res!, ref.size);
    if (packed.length !== ref.size || createHash("sha256").update(packed).digest("hex") !== ref.sha256) {
      throw new UpdateError("corrupt", "the manifest does not match its pointer");
    }
    let json: Buffer;
    try {
      json = zstdDecompressSync(packed, { maxOutputLength: MANIFEST_MAX_UNPACKED });
    } catch {
      throw new UpdateError("bad-release", "the manifest does not unpack");
    }
    const parsed = UpdateManifestSchema.safeParse(parseJson(json));
    if (!parsed.success) throw new UpdateError("bad-release", "the manifest is malformed");
    return parsed.data;
  }

  async range(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.get(path, { signal, headers: { range: `bytes=${offset}-${offset + length - 1}` } });
    if (res!.status !== 206) throw new UpdateError("bad-release", `the feed ignored a range request for ${path}`);
    const bytes = await readCapped(res!, length);
    if (bytes.length !== length) throw new UpdateError("network", `${path}: the range came back short`);
    return bytes;
  }

  async text(path: string, maxBytes: number): Promise<string> {
    return (await readCapped((await this.get(path))!, maxBytes)).toString("utf8");
  }

  private async get(
    path: string,
    opts: { optional?: boolean; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<Response | null> {
    const url = `${this.deps.baseUrl().replace(/\/+$/, "")}/${path}`;
    const doFetch = this.deps.fetch ?? fetch;
    const sleep = this.deps.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      let failure: string;
      try {
        const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await doFetch(url, { headers: opts.headers, signal, redirect: "follow" });
        if (res.ok) return res;
        if (res.status === 404 && opts.optional) return null;
        await res.body?.cancel();
        if (res.status !== 429 && res.status < 500) throw new UpdateError("bad-release", `${path}: the feed answered ${res.status}`);
        failure = `${path}: the feed answered ${res.status}`;
      } catch (e) {
        if (e instanceof UpdateError) throw e;
        opts.signal?.throwIfAborted();
        failure = `${path}: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (attempt >= BACKOFF_MS.length) throw new UpdateError("network", failure);
      await sleep(BACKOFF_MS[attempt], opts.signal);
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (declared > maxBytes) throw new UpdateError("bad-release", `the feed sent ${declared} bytes where at most ${maxBytes} fit`);
  if (!res.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += part.length;
    if (total > maxBytes) throw new UpdateError("bad-release", `the feed sent more than ${maxBytes} bytes`);
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts, total);
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UpdateError("bad-release", "the feed sent something that is not JSON");
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
