import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayConfig } from "../config.ts";
import type { VaultEntry, VaultStore } from "./VaultStore.ts";

// HTTP face of the sync vault, next to the ws forwarder (Caddy proxies every path).
//   GET /vault/v1/:vault/changes?since=N&wait=S&limit=L
//   PUT /vault/v1/:vault/records/:key  {baseSeq, data}

// Long-polls parked per vault; a successful put wakes them all.
export type VaultWaiters = Map<string, Set<() => void>>;

const VAULT_RE = /^[a-f0-9]{32}$/;
const KEY_RE = /^[a-f0-9]{64}$/;
const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{16,128})$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_WAIT_S = 25;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type VaultConfig = Pick<RelayConfig, "maxBlobBytes">;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function wire(e: VaultEntry): { key: string; seq: number; data: string } {
  return { key: e.key, seq: e.seq, data: e.data.toString("base64") };
}

function intParam(v: string | null, fallback: number): number | null {
  if (v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function waitForPut(waiters: VaultWaiters, vault: string, ms: number, res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    let set = waiters.get(vault);
    if (!set) waiters.set(vault, (set = new Set()));
    const parked = set;
    const done = () => {
      clearTimeout(timer);
      res.off("close", done);
      parked.delete(done);
      if (parked.size === 0 && waiters.get(vault) === parked) waiters.delete(vault);
      resolve();
    };
    const timer = setTimeout(done, ms);
    parked.add(done);
    res.on("close", done);
  });
}

function wake(waiters: VaultWaiters, vault: string): void {
  for (const done of [...(waiters.get(vault) ?? [])]) done();
}

// Keeps at most `cap` bytes; null once the body runs past it. The rest is discarded
// rather than destroying the request, so the client still reads the 413.
function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= cap) return void chunks.push(chunk);
      req.off("data", onData);
      req.resume();
      resolve(null);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function changes(res: ServerResponse, url: URL, vault: string, store: VaultStore, waiters: VaultWaiters): Promise<void> {
  const since = intParam(url.searchParams.get("since"), 0);
  const wait = intParam(url.searchParams.get("wait"), 0);
  const limit = intParam(url.searchParams.get("limit"), DEFAULT_LIMIT);
  if (since === null || wait === null || limit === null) return send(res, 400, { error: "bad query" });
  const pageSize = Math.min(Math.max(limit, 1), MAX_LIMIT);
  let page = store.changes(vault, since, pageSize);
  if (page.entries.length === 0 && wait > 0) {
    await waitForPut(waiters, vault, Math.min(wait, MAX_WAIT_S) * 1000, res);
    if (res.destroyed) return;
    page = store.changes(vault, since, pageSize);
  }
  send(res, 200, { head: page.head, entries: page.entries.map(wire), more: page.more });
}

async function put(req: IncomingMessage, res: ServerResponse, vault: string, key: string, store: VaultStore, waiters: VaultWaiters, config: VaultConfig): Promise<void> {
  // base64 of the largest blob plus room for the JSON around it.
  const cap = Math.ceil(config.maxBlobBytes / 3) * 4 + 1024;
  const tooLarge = () => send(res, 413, { error: "blob too large" }, { connection: "close" });
  if (Number(req.headers["content-length"] ?? 0) > cap) return tooLarge();
  const raw = await readBody(req, cap);
  if (!raw) return tooLarge();
  let body: { baseSeq?: unknown; data?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return send(res, 400, { error: "bad json" });
  }
  const { baseSeq, data } = body ?? {};
  if (!Number.isSafeInteger(baseSeq) || (baseSeq as number) < 0) return send(res, 400, { error: "bad baseSeq" });
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64_RE.test(data)) return send(res, 400, { error: "bad data" });
  const blob = Buffer.from(data, "base64");
  if (blob.length > config.maxBlobBytes) return tooLarge();
  const result = store.put(vault, key, baseSeq as number, blob);
  if (result.ok) {
    send(res, 200, { seq: result.seq });
    wake(waiters, vault);
  } else if (result.reason === "conflict") {
    send(res, 409, { entry: result.entry ? wire(result.entry) : null });
  } else {
    send(res, 507, { error: "vault quota" });
  }
}

// false when the path isn't a vault route (the caller answers it).
export function handleVault(req: IncomingMessage, res: ServerResponse, store: VaultStore, waiters: VaultWaiters, config: VaultConfig): boolean {
  const url = new URL(req.url ?? "/", "http://relay");
  if (!url.pathname.startsWith("/vault/v1/")) return false;
  const m = /^\/vault\/v1\/([^/]+)\/(?:(changes)|records\/([^/]+))$/.exec(url.pathname);
  if (!m) {
    send(res, 404, { error: "not found" });
    return true;
  }
  const [, vault, isChanges, key] = m;
  const method = isChanges ? "GET" : "PUT";
  if (req.method !== method) {
    send(res, 405, { error: "method not allowed" }, { allow: method });
    return true;
  }
  if (!VAULT_RE.test(vault) || (key !== undefined && !KEY_RE.test(key))) {
    send(res, 400, { error: "bad vault or key" });
    return true;
  }
  const auth = BEARER_RE.exec(req.headers.authorization ?? "");
  if (!auth) {
    send(res, 401, { error: "unauthorized" });
    return true;
  }
  const verdict = store.authorize(vault, auth[1]);
  if (verdict === "forbidden") {
    send(res, 403, { error: "forbidden" });
    return true;
  }
  if (verdict === "full") {
    send(res, 503, { error: "vault limit" });
    return true;
  }
  const work = isChanges ? changes(res, url, vault, store, waiters) : put(req, res, vault, key, store, waiters, config);
  work.catch((e) => send(res, 500, { error: e instanceof Error ? e.message : String(e) }));
  return true;
}
