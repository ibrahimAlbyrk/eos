// Sends a phone notification through Apple's push service (07 §4.6). The payload comes from a
// fixed table keyed by a closed kind and a count: nothing written by a user, an agent or an
// outside service reaches Apple. Logs nothing: callers log counts only.
import { createHash } from "node:crypto";
import http2, { type ClientHttp2Session } from "node:http2";
import type { ApnsConfig, ApnsOrigins } from "../config.ts";
import { ProviderToken } from "./jwt.ts";

export const PUSH_KINDS = ["needs_you", "run_failed", "routine_paused", "ready", "test"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export type ApnsEnv = keyof ApnsOrigins;
export type PushTarget = { token: string; env: ApnsEnv };
export type TokenResult = { result: "sent" } | { result: "gone" } | { result: "failed"; reason: string };

const EXPIRY_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const IDLE_SESSION_MS = 5 * 60 * 1000;
const DEVICE_TOKEN = /^[0-9a-fA-F]{1,200}$/;
const GONE_REASONS = new Set(["BadDeviceToken", "Unregistered"]);

export function isPushKind(value: unknown): value is PushKind {
  return typeof value === "string" && (PUSH_KINDS as readonly string[]).includes(value);
}

export function isPushCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function pushPayload(room: string, kind: PushKind, count: number): string {
  return JSON.stringify({
    aps: {
      alert: { "title-loc-key": `push.${kind}.title`, "loc-key": `push.${kind}.body`, "loc-args": [String(count)] },
      badge: count,
      sound: "default",
      "thread-id": kind,
    },
    m: createHash("sha256").update(room).digest("hex").slice(0, 8),
  });
}

export class ApnsSender {
  private readonly config: { apns: ApnsConfig | null; apnsOrigins: ApnsOrigins };
  private readonly now: () => number;
  private readonly token: ProviderToken | null;
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(config: { apns: ApnsConfig | null; apnsOrigins: ApnsOrigins }, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
    const apns = config.apns;
    this.token = apns ? new ProviderToken(apns.keyPath, apns.keyId, apns.teamId, now) : null;
  }

  /** Throws on an unknown kind or a count that is not a whole number, before anything is sent. */
  async send(room: string, kind: string, count: number, targets: PushTarget[]): Promise<"not-configured" | TokenResult[]> {
    if (!isPushKind(kind)) throw new RangeError("unknown push kind");
    if (!isPushCount(count)) throw new RangeError("push count must be a whole number");
    const apns = this.config.apns;
    if (!this.token || !apns) return "not-configured";
    const payload = pushPayload(room, kind, count);
    const headers = {
      ":method": "POST",
      authorization: `bearer ${this.token.get()}`,
      "apns-push-type": "alert",
      "apns-topic": apns.bundleId,
      "apns-collapse-id": kind,
      "apns-expiration": String(Math.floor(this.now() / 1000) + EXPIRY_SECONDS),
      "apns-priority": "10",
    };
    return Promise.all(targets.map((target) => this.sendOne(target, headers, payload)));
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private async sendOne(target: PushTarget, headers: Record<string, string>, payload: string): Promise<TokenResult> {
    // APNs would answer BadDeviceToken; refusing here also keeps the token out of the path's syntax.
    if (!DEVICE_TOKEN.test(target.token)) return { result: "gone" };
    let answer: { status: number; body: string };
    try {
      answer = await this.post(this.session(this.config.apnsOrigins[target.env]), { ...headers, ":path": `/3/device/${target.token}` }, payload);
    } catch (error) {
      return { result: "failed", reason: error instanceof TimeoutError ? "timeout" : "unreachable" };
    }
    if (answer.status === 200) return { result: "sent" };
    const reason = reasonOf(answer.body) ?? `status-${answer.status}`;
    if (answer.status === 410 || (answer.status === 400 && GONE_REASONS.has(reason))) return { result: "gone" };
    return { result: "failed", reason };
  }

  private session(origin: string): ClientHttp2Session {
    const open = this.sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(origin);
    const forget = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("close", forget);
    session.on("goaway", forget);
    session.on("error", forget);
    session.setTimeout(IDLE_SESSION_MS, () => session.close());
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  private post(session: ClientHttp2Session, headers: Record<string, string>, payload: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = session.request(headers);
      let status = 0;
      let body = "";
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.close(http2.constants.NGHTTP2_CANCEL);
        reject(new TimeoutError());
      });
      request.on("response", (answer) => (status = Number(answer[":status"])));
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      // A stream that ends without an answer means the connection went away under it.
      request.on("end", () => (status ? resolve({ status, body }) : reject(new Error("no answer"))));
      request.on("error", reject);
      request.end(payload);
    });
  }
}

class TimeoutError extends Error {}

function reasonOf(body: string): string | null {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === "string" && /^[A-Za-z]{1,64}$/.test(reason) ? reason : null;
  } catch {
    return null;
  }
}
