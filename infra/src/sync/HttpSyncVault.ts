// HttpSyncVault — the relay vault (relay/vault/routes.ts) over HTTPS. The relay URL
// in the sync key is the ws URL the phone/peer relay already uses; the vault is
// served by the same host.

import type { SyncPutResult, SyncVault, SyncVaultChanges, SyncVaultEntry } from "../../../core/src/ports/SyncVault.ts";
import { VaultChangesWireSchema, VaultEntryWireSchema, type VaultEntryWire } from "../../../contracts/src/sync.ts";

const PAGE_LIMIT = 200;
// Headroom over the long-poll wait before a request counts as hung.
const REQUEST_SLACK_MS = 20_000;

export interface HttpSyncVaultOptions {
  readonly relayUrl: string;
  readonly vaultId: string;
  readonly authToken: string;
}

interface VaultRequest {
  readonly method: "GET" | "PUT";
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export class HttpSyncVault implements SyncVault {
  private readonly base: string;
  private readonly authToken: string;

  constructor(opts: HttpSyncVaultOptions) {
    const http = opts.relayUrl.replace(/^ws(s?):/, "http$1:").replace(/\/+$/, "");
    this.base = `${http}/vault/v1/${opts.vaultId}`;
    this.authToken = opts.authToken;
  }

  async changes(since: number, waitMs: number, signal?: AbortSignal): Promise<SyncVaultChanges> {
    const wait = Math.ceil(waitMs / 1000);
    const res = await this.request(`/changes?since=${since}&wait=${wait}&limit=${PAGE_LIMIT}`, { method: "GET" }, waitMs, signal);
    const body = VaultChangesWireSchema.parse(await this.json(res, [200]));
    return { head: body.head, more: body.more, entries: body.entries.map(fromWire) };
  }

  async put(key: string, baseSeq: number, data: Uint8Array): Promise<SyncPutResult> {
    const res = await this.request(`/records/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseSeq, data: Buffer.from(data).toString("base64") }),
    }, 0);
    const body = (await this.json(res, [200, 409])) as { seq?: number; entry?: unknown };
    if (res.status === 200) return { ok: true, seq: Number(body.seq) };
    // The vault lost the record this Mac last saw (a reset relay) — write it afresh.
    if (body.entry == null) return baseSeq === 0 ? Promise.reject(new Error("vault refused a new record")) : this.put(key, 0, data);
    return { ok: false, entry: fromWire(VaultEntryWireSchema.parse(body.entry)) };
  }

  private request(path: string, init: VaultRequest, waitMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(waitMs + REQUEST_SLACK_MS);
    return fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.authToken}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  private async json(res: Response, ok: readonly number[]): Promise<unknown> {
    const body = await res.json().catch(() => ({})) as { error?: string };
    if (!ok.includes(res.status)) throw new Error(`sync vault: ${res.status} ${body.error ?? res.statusText}`);
    return body;
  }
}

function fromWire(e: VaultEntryWire): SyncVaultEntry {
  return { key: e.key, seq: e.seq, data: new Uint8Array(Buffer.from(e.data, "base64")) };
}
