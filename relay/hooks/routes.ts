import type { IncomingMessage, IncomingHttpHeaders, ServerResponse } from "node:http";
import type { HookRate } from "./rate.ts";
import { isPublicKey, seal } from "./seal.ts";
import type { HookStore } from "./HookStore.ts";

// HTTP face of the hook inbox (07 §4.7), beside the vault:
//   PUT    /hooks/v1/:inbox {publicKey}        the Mac, Bearer: 200 · 503 past the inbox cap
//   PUT    /hooks/v1/:inbox/hooks/:hook        the Mac: 200 · 409 another inbox's id · 507 past 64 hooks
//   DELETE /hooks/v1/:inbox/hooks/:hook        the Mac: 200
//   POST   /hooks/v1/:inbox/:hook              anyone (the URL is the capability): 202 · 404 · 413 · 429 · 507
//   GET    /hooks/v1/:inbox/events?since&wait  the Mac: {head, entries:[{seq, sealed}], dropped}
//   POST   /hooks/v1/:inbox/ack {through}      the Mac: 200
// Nothing here logs: inbox and hook ids are capabilities, bodies are the services' content.

export type HookWaiters = Map<string, Set<() => void>>;

const ID_RE = /^[a-f0-9]{32}$/;
const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{16,128})$/;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_WAIT_S = 25;
const PAGE = 100;
// What a proxy or a browser adds: never the service's content, sometimes a secret.
const DROPPED_HEADERS = new Set(["cookie", "authorization", "proxy-authorization", "proxy-connection", "forwarded", "via", "x-real-ip"]);

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req, 4096);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw.toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The headers the Mac needs to check a signature, in arrival order, at most 8 KiB in all.
export function keptHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const kept: Record<string, string> = {};
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_HEADERS.has(name) || name.startsWith("x-forwarded-")) continue;
    const text = Array.isArray(value) ? value.join(", ") : value;
    bytes += name.length + text.length;
    if (bytes > MAX_HEADER_BYTES) break;
    kept[name] = text;
  }
  return kept;
}

function park(waiters: HookWaiters, inbox: string, ms: number, res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    let set = waiters.get(inbox);
    if (!set) waiters.set(inbox, (set = new Set()));
    const parked = set;
    const done = () => {
      clearTimeout(timer);
      res.off("close", done);
      parked.delete(done);
      if (parked.size === 0 && waiters.get(inbox) === parked) waiters.delete(inbox);
      resolve();
    };
    const timer = setTimeout(done, ms);
    parked.add(done);
    res.on("close", done);
  });
}

function wake(waiters: HookWaiters, inbox: string): void {
  for (const done of [...(waiters.get(inbox) ?? [])]) done();
}

function intParam(v: string | null): number | null {
  if (v === null || v === "") return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

type Ctx = { store: HookStore; rate: HookRate; waiters: HookWaiters; now: () => number };

async function deliver(req: IncomingMessage, res: ServerResponse, inbox: string, hook: string, ctx: Ctx): Promise<void> {
  const recipient = ctx.store.recipient(inbox, hook);
  if (!recipient) return send(res, 404, { error: "unknown hook" });
  if (!ctx.rate.take(hook)) return send(res, 429, { error: "too many events" });
  const tooLarge = () => send(res, 413, { error: "body too large" }, { connection: "close" });
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return tooLarge();
  const body = await readBody(req, MAX_BODY_BYTES);
  if (!body) return tooLarge();
  const plaintext = JSON.stringify({ hook, receivedAt: ctx.now(), headers: keptHeaders(req.headers), body: body.toString("base64") });
  const seq = ctx.store.append(inbox, seal(recipient, Buffer.from(plaintext, "utf8")));
  if (seq === "full") return send(res, 507, { error: "inbox full" });
  send(res, 202, {});
  wake(ctx.waiters, inbox);
}

async function ensure(req: IncomingMessage, res: ServerResponse, inbox: string, bearer: string, ctx: Ctx): Promise<void> {
  const body = await readJson(req);
  const key = typeof body?.publicKey === "string" ? Buffer.from(body.publicKey, "base64") : null;
  if (!key || !isPublicKey(key)) return send(res, 400, { error: "bad publicKey" });
  const verdict = ctx.store.ensure(inbox, bearer, key);
  if (verdict === "forbidden") return send(res, 403, { error: "forbidden" });
  if (verdict === "full") return send(res, 503, { error: "inbox limit" });
  send(res, 200, {});
}

async function events(res: ServerResponse, url: URL, inbox: string, ctx: Ctx): Promise<void> {
  const since = intParam(url.searchParams.get("since"));
  const wait = intParam(url.searchParams.get("wait"));
  if (since === null || wait === null) return send(res, 400, { error: "bad query" });
  let page = ctx.store.events(inbox, since, PAGE);
  if (page.entries.length === 0 && wait > 0) {
    await park(ctx.waiters, inbox, Math.min(wait, MAX_WAIT_S) * 1000, res);
    if (res.destroyed) return;
    page = ctx.store.events(inbox, since, PAGE);
  }
  send(res, 200, { head: page.head, entries: page.entries.map((e) => ({ seq: e.seq, sealed: e.sealed.toString("base64") })), dropped: page.dropped });
}

async function ack(req: IncomingMessage, res: ServerResponse, inbox: string, ctx: Ctx): Promise<void> {
  const body = await readJson(req);
  const through = body?.through;
  if (!Number.isSafeInteger(through) || (through as number) < 0) return send(res, 400, { error: "bad through" });
  ctx.store.ack(inbox, through as number);
  send(res, 200, {});
}

// The Mac's own requests: its bearer must be the one the inbox pinned.
function macRoute(req: IncomingMessage, res: ServerResponse, url: URL, inbox: string, rest: string | undefined, ctx: Ctx): Promise<void> | void {
  const auth = BEARER_RE.exec(req.headers.authorization ?? "");
  if (!auth) return send(res, 401, { error: "unauthorized" });
  if (rest === undefined) {
    if (req.method !== "PUT") return send(res, 405, { error: "method not allowed" }, { allow: "PUT" });
    return ensure(req, res, inbox, auth[1], ctx);
  }
  const verdict = ctx.store.authorize(inbox, auth[1]);
  if (verdict === "unknown") return send(res, 404, { error: "unknown inbox" });
  if (verdict === "forbidden") return send(res, 403, { error: "forbidden" });
  if (rest === "events") {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" }, { allow: "GET" });
    return events(res, url, inbox, ctx);
  }
  if (rest === "ack") {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST" });
    return ack(req, res, inbox, ctx);
  }
  const hook = rest.slice("hooks/".length);
  if (!ID_RE.test(hook)) return send(res, 400, { error: "bad hook" });
  if (req.method === "DELETE") {
    ctx.store.removeHook(inbox, hook);
    return send(res, 200, {});
  }
  if (req.method !== "PUT") return send(res, 405, { error: "method not allowed" }, { allow: "PUT, DELETE" });
  const added = ctx.store.addHook(inbox, hook);
  if (added === "taken") return send(res, 409, { error: "hook taken" });
  if (added === "full") return send(res, 507, { error: "hook limit" });
  send(res, 200, {});
}

// false when the path isn't a hook route (the caller answers it).
export function handleHooks(req: IncomingMessage, res: ServerResponse, ctx: Ctx): boolean {
  const url = new URL(req.url ?? "/", "http://relay");
  if (!url.pathname.startsWith("/hooks/v1/")) return false;
  const m = /^\/hooks\/v1\/([^/]+)(?:\/(events|ack|hooks\/[^/]+|[^/]+))?$/.exec(url.pathname);
  if (!m || !ID_RE.test(m[1])) {
    send(res, 404, { error: "not found" });
    return true;
  }
  const [, inbox, rest] = m;
  const fail = (e: unknown) => send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  if (rest !== undefined && ID_RE.test(rest)) {
    if (req.method !== "POST") send(res, 405, { error: "method not allowed" }, { allow: "POST" });
    else deliver(req, res, inbox, rest, ctx).catch(fail);
    return true;
  }
  if (rest !== undefined && rest !== "events" && rest !== "ack" && !rest.startsWith("hooks/")) {
    send(res, 404, { error: "not found" });
    return true;
  }
  const work = macRoute(req, res, url, inbox, rest, ctx);
  if (work) work.catch(fail);
  return true;
}
