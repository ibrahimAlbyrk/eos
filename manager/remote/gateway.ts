// Remote gateway driver (relay v3). ONE surface: a per-device relay session.
// With encryption removed there is no handshake — the relay's `join` admission
// (SHA-256(bearer) membership) is the whole auth step. When the relay acks a
// join, the daemon immediately spins up a live session: control frames dispatch
// into the EXISTING route handlers while the EventBus fans out as plaintext
// `event` frames.
//
// A `data (0x01)` envelope's payload is plaintext UTF-8 JSON (§5) — the relay,
// which you self-host, can see it (the explicit trade of removing AEAD). There
// is no per-action step-up and no reduced-capability tier: every session is
// dispatched at full capability, gated only by the REFUSED set + the ✦ ui-token.

import { randomBytes } from "node:crypto";

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { FrameType, Dir, MAX_ENVELOPE_BYTES, encodeJsonEnvelope, parseEnvelope, type Envelope } from "./envelope.ts";
import { encodeServerFrame, decodeClientFrame } from "./framer.ts";
import { ControlDispatcher, type RouteDispatch, type DispatchSession } from "./dispatch.ts";
import { WsBridge, type RemoteSession, type ServerFrame } from "./WsBridge.ts";
import type { RemoteAuditLog } from "./audit.ts";
import { REMOTE_CAPS, type ControlFrame, type FocusFrame, type LiveBlock } from "../../contracts/src/remote.ts";

// Every relay session holds the full capability set — "mutate" gates the local
// ui-token for ✦ routes. "highrisk" is retained for completeness but is no longer
// checked in dispatch (HIGH routes pass for any joined session); there is no
// step-up tier to withhold anymore (no SE key), so a joined device gets them all.
export const SESSION_CAPS = ["read", "lowrisk", "mutate", "highrisk"] as const;

export interface GatewayDeps {
  audit: RemoteAuditLog;
  uiToken: string;
  routeDispatch: RouteDispatch;
  bus: EventBus;
  room: string;
  now: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  // In-flight streaming text for the snapshot (LiveText); absent ⇒ none sent.
  liveText?: { snapshot(): LiveBlock[]; blocksFor?(workerId: string): LiveBlock[] };
}

// A patch pushed while the snapshot's list reads are in flight carries NEWER
// rows than the reads may return; the device applies the snapshot after it, so
// re-read until no patch slipped in between (bounded — a busy daemon settles).
const SNAPSHOT_READ_ATTEMPTS = 3;

// One page of pushed transcript rows — the phone's own delta page size.
const ROWS_PAGE = 500;
const PTY_INPUT_PATH = /^\/pty\/[^/]+\/input$/;

// What a focused phone gets as events; everything else reaches it as patches
// (worker/pending state) or not at all. Keyed by topic → is it for the screen.
type FocusTest = (focus: FocusFrame, payload: Record<string, unknown>, conn: { rows: boolean; ptySubs: Set<string> }) => boolean;
const FOR_OPEN_WORKER: FocusTest = (f, p) => p.workerId === f.worker;
const FOCUSED_TOPICS: Record<string, FocusTest> = {
  "agent:delta": FOR_OPEN_WORKER,
  "terminal:chunk": FOR_OPEN_WORKER,
  "terminal:done": FOR_OPEN_WORKER,
  "loop:check": FOR_OPEN_WORKER,
  // Only a phone that doesn't take pushed rows fetches the transcript on this nudge.
  "worker:change": (f, p, c) => !c.rows && p.workerId === f.worker,
  "pty:session": () => true,
  "pty:exit": () => true,
  "pty:conversation": (f, p, c) => p.sessionId === f.pty || c.ptySubs.has(String(p.sessionId)),
};

// Drives ONE device connection: on join-ack (relay-assigned clientId) go live
// immediately, then dispatch each incoming `data` frame. `send` writes a raw
// outer-envelope buffer to the transport (the relay's s2c pipe).
export class GatewayConnection {
  private readonly deps: GatewayDeps;
  private readonly bridge: WsBridge;
  private readonly send: (buf: Buffer) => void;
  private readonly close: (reason?: string) => void;
  private readonly clientId: Buffer;
  private readonly dispatcher: ControlDispatcher;
  private session: RemoteSession | null = null;
  private ptySubs = new Set<string>(); // PTY sessions whose raw output this device shows (sub frame)
  private readonly joinAck: boolean;
  // A current relay announces a departed device (`left`); an older one doesn't,
  // so liveness is also inferred from inbound traffic: the phone sends a ka
  // every 20s while its socket is open, and hello/control frames count too.
  // wire.ts sweeps sessions whose lastActivityAt is older than the idle TTL.
  private lastActivity: number;
  // What the phone listed in its hello; what it shows (null until a focus
  // frame — an older app gets every event).
  private caps = new Set<string>();
  private focus: FocusFrame | null = null;
  // The snapshot sent on join answers the phone's first hello.
  private bootSnapshot = false;
  private helloSeen = false;
  // Pushed transcript rows (cap "rows"): the focused worker and the newest row
  // id the phone holds for it (null until it says).
  private rowsWorker: string | null = null;
  private rowsCursor: number | null = null;
  private pulling = false;
  private pullAgain = false;
  private unsubRows: (() => void) | null = null;
  // Keystrokes in arrival order, though controls are otherwise handled concurrently.
  private inputChain: Promise<unknown> = Promise.resolve();

  constructor(args: {
    deps: GatewayDeps; bridge: WsBridge;
    send: (buf: Buffer) => void; close: (reason?: string) => void; clientId?: Buffer;
    joinAck?: boolean;
  }) {
    this.deps = args.deps;
    this.bridge = args.bridge;
    this.send = args.send;
    this.close = args.close;
    this.clientId = args.clientId ?? randomBytes(16);
    this.joinAck = args.joinAck ?? true;
    this.lastActivity = args.deps.now();
    this.dispatcher = new ControlDispatcher({
      routeDispatch: args.deps.routeDispatch, audit: args.deps.audit,
      uiToken: args.deps.uiToken, now: args.deps.now,
    });
  }

  // Relay mode: the relay is the clientId authority and already sent the join-ack
  // to both peers, so the daemon goes live straight away (joinAck defaults false
  // from the relay wiring). The LAN-style self-ack path is kept only for a caller
  // that owns clientId assignment itself.
  start(): void {
    if (this.joinAck) {
      this.send(encodeJsonEnvelope({
        type: FrameType.relayctl, room: this.deps.room, dir: Dir.s2c, clientId: this.clientId,
        json: { t: "joined", clientId: this.clientId.toString("base64url"), room: this.deps.room },
      }));
    }
    this.goLive();
  }

  private goLive(): void {
    if (this.session) return;
    this.session = {
      id: this.clientId.toString("hex"),
      send: (f: ServerFrame) => this.send(encodeServerFrame({
        room: this.deps.room, clientId: this.clientId, frame: f, compress: this.caps.has("deflate"),
      })),
      close: (reason?: string) => this.close(reason),
      wantsPty: (id: string) => this.ptySubs.has(id),
      wants: (topic, payload) => this.wants(topic, payload),
    };
    this.bridge.add(this.session);
    this.unsubRows = this.deps.bus.subscribe("worker:change", (msg) => {
      if (msg.topic !== "worker:change" || !this.rowsWorker) return;
      if ((msg.payload as { workerId?: unknown } | null)?.workerId === this.rowsWorker) void this.pullRows();
    });
    this.deps.log?.("remote device live", { clientId: this.session.id });
    // Seed the phone at once instead of waiting a round trip for its hello.
    this.bootSnapshot = true;
    void this.sendSnapshot(true).catch((e) =>
      this.deps.log?.("remote snapshot failed", { error: e instanceof Error ? e.message : String(e) }));
  }

  onMessage(buf: Buffer): void {
    if (buf.length > MAX_ENVELOPE_BYTES) { this.fail("FRAME_TOO_LARGE"); return; }
    let env: Envelope;
    try { env = parseEnvelope(buf); } catch { return; }
    this.onEnvelope(env);
  }

  lastActivityAt(): number { return this.lastActivity; }

  onEnvelope(env: Envelope): void {
    if (env.type !== FrameType.data) return; // gateway only consumes data-typed frames
    this.lastActivity = this.deps.now();
    void this.onLiveFrame(env).catch((e) =>
      this.deps.log?.("remote dispatch error", { error: e instanceof Error ? e.message : String(e) }));
  }

  private async onLiveFrame(env: Envelope): Promise<void> {
    const frame = decodeClientFrame(env);
    if (!frame) { this.deps.log?.("remote frame rejected (bad shape)", {}); return; }
    if (frame.t === "ka") return;
    if (frame.t === "hello") {
      this.caps = new Set(frame.caps ?? []);
      // The first hello asks for what the join snapshot already sent.
      const answered = this.bootSnapshot && !this.helloSeen;
      this.helloSeen = true;
      if (!answered) await this.sendSnapshot(false); // §5.4.3: resume / seq-gap recovery
      return;
    }
    if (frame.t === "sub") { this.ptySubs = new Set(frame.pty); return; }
    if (frame.t === "focus") { this.onFocus(frame); return; }
    if (frame.method === "POST" && PTY_INPUT_PATH.test(frame.path.split("?")[0])) {
      const run = this.inputChain.then(() => this.dispatchControl(frame));
      this.inputChain = run.catch(() => {});
      await run;
      return;
    }
    await this.dispatchControl(frame);
  }

  private async dispatchControl(frame: ControlFrame): Promise<void> {
    const ds: DispatchSession = { devId: this.clientId.toString("hex"), hasCap: (c) => SESSION_CAPS.includes(c as typeof SESSION_CAPS[number]) };
    const reply = await this.dispatcher.handle(ds, frame);
    this.deps.log?.("remote control", { method: frame.method, path: frame.path, status: reply.t === "reply" ? reply.status : reply.t });
    this.session?.send(reply);
  }

  private wants(topic: string, payload: unknown): boolean {
    const focus = this.focus;
    if (!focus) return true;
    if (!focus.active) return false;
    const test = FOCUSED_TOPICS[topic];
    const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    return test ? test(focus, p, { rows: this.caps.has("rows"), ptySubs: this.ptySubs }) : false;
  }

  // A new focus: with cap "rows", follow the open worker's transcript. A worker
  // newly on screen first gets the text already streamed for its live blocks,
  // sent at once: every later delta goes out after it, so the phone replaces
  // what its buffers hold with it and appends from there.
  private onFocus(f: FocusFrame): void {
    const wasActive = this.focus?.active === true;
    this.focus = f;
    if (!this.caps.has("rows")) return;
    const worker = f.active ? f.worker ?? null : null;
    if (worker !== this.rowsWorker || (f.active && !wasActive)) {
      this.rowsWorker = worker;
      this.rowsCursor = null;
      const live = worker ? this.deps.liveText?.blocksFor?.(worker) ?? [] : [];
      if (worker && live.length > 0) this.session?.send({ t: "rows", seq: this.bridge.currentSeq(), workerId: worker, rows: [], live });
    }
    if (worker && f.afterId != null) this.rowsCursor = f.afterId;
    void this.pullRows();
  }

  // Single-flight: changes landing mid-read collapse into one more read.
  private async pullRows(): Promise<void> {
    if (this.pulling) { this.pullAgain = true; return; }
    this.pulling = true;
    try {
      do {
        this.pullAgain = false;
        const worker = this.rowsWorker;
        const cursor = this.rowsCursor;
        if (!worker || !this.session) break;
        let rows: Array<Record<string, unknown>> = [];
        if (cursor != null) {
          const r = await this.deps.routeDispatch({
            method: "GET", path: `/workers/${encodeURIComponent(worker)}/events?afterId=${cursor}&limit=${ROWS_PAGE}`, body: {},
          });
          rows = "body" in r && Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
          // The focus moved on while this read ran — its rows belong to nobody now.
          if (worker !== this.rowsWorker || cursor !== this.rowsCursor) { this.pullAgain = true; continue; }
          const newest = rows.reduce((m, row) => (typeof row.id === "number" && row.id > m ? row.id : m), cursor);
          this.rowsCursor = newest;
          if (rows.length >= ROWS_PAGE) this.pullAgain = true;
        }
        if (rows.length > 0) this.session.send({ t: "rows", seq: this.bridge.currentSeq(), workerId: worker, rows });
      } while (this.pullAgain);
    } finally {
      this.pulling = false;
    }
  }

  // Answer a `hello` with a full §5.4.3 snapshot: the device declared a resume
  // cursor (reconnect) or detected a seq gap; either way a full re-seed from the
  // authoritative list routes is the recovery. `seq` carries the bridge cursor at
  // snapshot time so the device resumes gap detection from here. `boot` (sent on
  // join): also the terminal list and ui-config the phone would fetch next.
  private async sendSnapshot(boot: boolean): Promise<void> {
    const rows = (r: Awaited<ReturnType<GatewayDeps["routeDispatch"]>>): unknown[] =>
      ("body" in r && Array.isArray(r.body) ? r.body : []);
    const extras: { ptys?: unknown[]; uiConfig?: unknown } = {};
    if (boot) {
      const [ptys, uiConfig] = await Promise.all([
        this.deps.routeDispatch({ method: "GET", path: "/pty", body: {}, uiToken: this.deps.uiToken }),
        this.deps.routeDispatch({ method: "GET", path: "/api/ui-config", body: {}, uiToken: this.deps.uiToken }),
      ]);
      const sessions = "body" in ptys && ptys.status === 200 ? (ptys.body as { sessions?: unknown })?.sessions : undefined;
      if (Array.isArray(sessions)) extras.ptys = sessions;
      if ("body" in uiConfig && uiConfig.status === 200) extras.uiConfig = uiConfig.body;
    }
    let workers: unknown[] = [];
    let pending: unknown[] = [];
    for (let attempt = 1; attempt <= SNAPSHOT_READ_ATTEMPTS; attempt++) {
      const patchSeq = this.bridge.lastPatchSeq();
      const [w, p] = await Promise.all([
        this.deps.routeDispatch({ method: "GET", path: "/workers", body: {} }),
        this.deps.routeDispatch({ method: "GET", path: "/pending", body: {} }),
      ]);
      workers = rows(w);
      pending = rows(p);
      if (this.bridge.lastPatchSeq() === patchSeq) break;
    }
    // Synchronous from here: seq, epoch and live text describe the same instant.
    this.session?.send({
      t: "snapshot", seq: this.bridge.currentSeq(), epoch: this.bridge.epoch(),
      workers, pending, live: this.deps.liveText?.snapshot() ?? [], caps: [...REMOTE_CAPS], ...extras,
    });
    this.deps.log?.("remote snapshot sent", { workers: workers.length, pending: pending.length, boot });
  }

  private fail(code: string): void {
    this.deps.log?.("remote connection rejected", { code });
    this.close(code);
  }

  dispose(): void {
    this.unsubRows?.();
    this.unsubRows = null;
    if (this.session) this.bridge.remove(this.session.id);
  }
}
