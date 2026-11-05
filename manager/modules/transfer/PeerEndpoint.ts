// A paired host's disk as a transfer endpoint: each call is one HTTP/2 stream on
// the link to that host's /transfer/* routes. This daemon vouches for itself as
// the human (x-eos-peer-human) — its engine only ever runs transfers the user
// started, or a focused agent started within the locked-down agent route.

import http2 from "node:http2";

import { HostInfoSchema, PEER_HUMAN_HEADER } from "../../../contracts/src/peer.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import {
  TransferCommitResultSchema, TransferErrorBodySchema, TransferKeyResponseSchema, TransferListingSchema,
  TransferLocateResponseSchema, TransferManifestSchema, TransferPrepareResultSchema,
  type TransferCommitRequest, type TransferCommitResult, type TransferListing, type TransferManifest,
  type TransferPrepareRequest, type TransferPrepareResult,
} from "../../../contracts/src/transfer.ts";
import { TransferError } from "../../../core/src/domain/transfer.ts";
import type { TransferEndpoint } from "../../../core/src/ports/TransferEndpoint.ts";
import type { HostLink } from "../../peer/HostLink.ts";
import type { z } from "zod";

// Long enough to ride out a network switch; the engine retries past it.
const READY_MS = 15_000;
// A chunk is sized to about a second; this only catches a stream that went silent.
const REQUEST_MS = 120_000;

export interface PeerEndpointDeps {
  readonly link: () => HostLink | null;
  // The host's home as its link last reported it.
  readonly home: () => string | null;
}

export class PeerEndpoint implements TransferEndpoint {
  private readonly deps: PeerEndpointDeps;

  constructor(deps: PeerEndpointDeps) {
    this.deps = deps;
  }

  async list(dir: string, opts?: { hidden?: boolean }): Promise<TransferListing> {
    const q = new URLSearchParams({ path: dir, ...(opts?.hidden ? { hidden: "1" } : {}) });
    return this.json(TransferListingSchema, "GET", `${ROUTES.transferList}?${q}`);
  }

  scan(paths: readonly string[]): Promise<TransferManifest> {
    return this.json(TransferManifestSchema, "POST", ROUTES.transferScan, { paths });
  }

  async read(path: string, range: { offset: number; length: number }, expect: { size: number; mtimeMs: number }): Promise<Uint8Array> {
    const q = new URLSearchParams({
      path, offset: String(range.offset), length: String(range.length), size: String(expect.size), mtime: String(expect.mtimeMs),
    });
    return this.call("GET", `${ROUTES.transferRead}?${q}`);
  }

  prepare(req: TransferPrepareRequest): Promise<TransferPrepareResult> {
    return this.json(TransferPrepareResultSchema, "POST", ROUTES.transferPrepare, req);
  }

  async write(at: { id: string; destDir: string; rel: string; offset: number }, data: Uint8Array): Promise<number> {
    const q = new URLSearchParams({ id: at.id, dest: at.destDir, rel: at.rel, offset: String(at.offset) });
    const body = JSON.parse((await this.call("PUT", `${ROUTES.transferWrite}?${q}`, data)).toString("utf8")) as { size?: unknown };
    if (typeof body.size !== "number") throw new TransferError("unreachable", "unexpected answer from the other computer");
    return body.size;
  }

  commit(req: TransferCommitRequest): Promise<TransferCommitResult> {
    return this.json(TransferCommitResultSchema, "POST", ROUTES.transferCommit, req);
  }

  async abort(req: { id: string; destDir: string }): Promise<void> {
    await this.call("POST", ROUTES.transferAbort, Buffer.from(JSON.stringify(req)), true);
  }

  async projectKey(dir: string): Promise<string | null> {
    return (await this.json(TransferKeyResponseSchema, "POST", ROUTES.transferKey, { path: dir })).key;
  }

  async locate(key: string): Promise<string | null> {
    return (await this.json(TransferLocateResponseSchema, "POST", ROUTES.transferLocate, { key })).path;
  }

  async home(): Promise<string> {
    const known = this.deps.home();
    if (known) return known;
    return (await this.json(HostInfoSchema, "GET", ROUTES.hostInfo)).home;
  }

  private async json<S extends z.ZodTypeAny>(schema: S, method: string, path: string, body?: unknown): Promise<z.infer<S>> {
    const raw = await this.call(method, path, body === undefined ? undefined : Buffer.from(JSON.stringify(body)), body !== undefined);
    const parsed = schema.safeParse(JSON.parse(raw.toString("utf8") || "null"));
    if (!parsed.success) throw new TransferError("needs-update", "the other computer answered in a format this Eos doesn't know — update both");
    return parsed.data;
  }

  private async call(method: string, path: string, payload?: Uint8Array, isJson = false): Promise<Buffer> {
    const link = this.deps.link();
    if (!link) throw new TransferError("unreachable", "that computer isn't paired any more");
    let session: http2.ClientHttp2Session;
    try {
      session = await link.ready(READY_MS);
    } catch {
      throw new TransferError("unreachable", "that computer isn't reachable right now");
    }
    const headers: http2.OutgoingHttpHeaders = { ":method": method, ":path": path, [PEER_HUMAN_HEADER]: "1" };
    if (payload) {
      headers["content-type"] = isJson ? "application/json" : "application/octet-stream";
      headers["content-length"] = payload.byteLength;
    }
    const { status, data } = await new Promise<{ status: number; data: Buffer }>((resolve, reject) => {
      const lost = (): TransferError => new TransferError("unreachable", "the link to that computer dropped");
      let req: http2.ClientHttp2Stream;
      try {
        req = session.request(headers, { endStream: !payload });
      } catch {
        reject(lost());
        return;
      }
      let status = 0;
      const chunks: Buffer[] = [];
      req.setTimeout(REQUEST_MS, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        reject(new TransferError("unreachable", "the other computer stopped answering"));
      });
      req.on("response", (h) => { status = Number(h[":status"]) || 0; });
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve({ status, data: Buffer.concat(chunks) }));
      req.on("error", () => reject(lost()));
      if (payload) req.end(payload);
    });
    if (status >= 200 && status < 300) return data;
    throw errorFrom(status, data);
  }
}

function errorFrom(status: number, data: Buffer): TransferError {
  let body: unknown = null;
  try { body = JSON.parse(data.toString("utf8")); } catch { /* not JSON */ }
  const known = TransferErrorBodySchema.safeParse(body);
  if (known.success) return new TransferError(known.data.code, known.data.error, known.data.have);
  // No /transfer/* there at all: an Eos from before file transfer.
  if (status === 404) return new TransferError("needs-update", "Eos on that computer is too old to send files — update it");
  if (status === 403) return new TransferError("forbidden", "that computer refused the transfer");
  return new TransferError("unreachable", `the other computer answered ${status}`);
}
