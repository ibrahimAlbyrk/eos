// iOS remote-control contracts — config shape, the inner-frame shapes the daemon
// validates on the wire, and the pairing-QR payload. The byte-exact wire details
// live in docs/mobile-redesign/01-plaintext-relay-protocol.md; this file is the
// single source of truth for the JSON shapes the daemon parses/produces.

import { z } from "zod";

// ---- config.remote (v3) — OFF by default -----------------------------------
// Relay-only. `enabled` arms the outbound relay leg. `relay.url` is the public
// wss endpoint the daemon dials and the phone dials. The room id + bearer are
// CSPRNG secrets minted by the daemon at arm time and persisted under
// ~/.eos/remote/ (room.id, bearer.secret, relay-owner.secret) — NOT config.
export const RemoteConfigSchema = z.object({
  enabled: z.boolean(),
  relay: z.object({ url: z.string().url() }).optional(),
  // Auto-expiring inactivity lease: auto-disarm after N ms idle. 0 = never.
  inactivityLeaseMs: z.number().int().nonnegative().optional(),
  // Gateway rate limits.
  rateLimit: z
    .object({
      perDevicePerMin: z.number().int().positive(),
      globalPerMin: z.number().int().positive(),
      pairingPerMin: z.number().int().positive(),
    })
    .partial()
    .optional(),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

// ---- Inner frames the daemon RECEIVES (client → server, §5.2) --------------
// The daemon reads a data frame's plaintext UTF-8 JSON payload to one object and
// validates it here before dispatch. Server→client frames (event/patch/snapshot/
// reply/asset/ka/error) are daemon-produced and typed below for the emitter.

// What one side of a phone link understands beyond the base protocol. The phone
// lists its own in `hello`, the Mac its own in `snapshot`; either side uses a
// feature only once the other has listed it, so old apps and old daemons keep
// the base behaviour.
//   focus   — the phone says what it shows (`focus` frame); the Mac then sends
//             live events only for that, and nothing but state patches while
//             the phone shows another Mac.
//   rows    — the Mac pushes new transcript rows of the focused worker (`rows`
//             frame) instead of a worker:change nudge the phone answers with a fetch.
//   deflate — a server frame may arrive compressed: DEFLATE_MARK + raw DEFLATE
//             of the frame's JSON.
export const REMOTE_CAPS = ["focus", "rows", "deflate"] as const;
export type RemoteCap = (typeof REMOTE_CAPS)[number];
export const DEFLATE_MARK = 0x01;

export const HelloFrameSchema = z.object({
  t: z.literal("hello"),
  lastContentId: z.number().int().nonnegative().nullable().optional(),
  caps: z.array(z.string()).max(16).optional(),
});

// What the phone shows for this Mac. `active` false = another Mac is on screen.
// `worker` = the open conversation; `afterId` = the newest row the phone holds
// for it (null/absent while it still loads its first page — no row push yet).
// `pty` = the open terminal screen (its pty:conversation nudges; raw output
// still follows `sub`).
export const FocusFrameSchema = z.object({
  t: z.literal("focus"),
  active: z.boolean(),
  worker: z.string().nullable().optional(),
  afterId: z.number().int().nonnegative().nullable().optional(),
  pty: z.string().nullable().optional(),
});
export type FocusFrame = z.infer<typeof FocusFrameSchema>;

export const ControlFrameSchema = z.object({
  t: z.literal("control"),
  correlationId: z.string().uuid(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string(),
  // body is an OPAQUE JSON STRING on the wire (§5.2.3) — NOT a nested object — so
  // the daemon dispatches the exact transmitted bytes. GET ⇒ "{}". Absent ⇒
  // treated as "{}".
  body: z.string().optional(),
});
export type ControlFrame = z.infer<typeof ControlFrameSchema>;

export const KaFrameSchema = z.object({ t: z.literal("ka"), ts: z.number().int() });

// The PTY sessions whose raw output (pty:data) this device wants — replaces the
// previous set. Terminal output is only streamed to a device that is showing it.
export const SubFrameSchema = z.object({
  t: z.literal("sub"),
  pty: z.array(z.string()).max(32),
});
export type SubFrame = z.infer<typeof SubFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion("t", [
  HelloFrameSchema,
  ControlFrameSchema,
  KaFrameSchema,
  SubFrameSchema,
  FocusFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ---- Server→client state-push frames (§5.4.1–5.4.3) ------------------------
// Typed here as the emitter's source of truth (the daemon produces, the phone
// consumes — the iOS decoder in InnerFrame.swift mirrors these shapes). `seq` is
// the per-bridge monotonic content cursor (§5.4.1), ordering only.

export const EventFrameSchema = z.object({
  t: z.literal("event"),
  seq: z.number().int(),
  reason: z.string(), // EventBus topic verbatim
  ts: z.number().int(),
  payload: z.unknown(),
});
export type EventFrame = z.infer<typeof EventFrameSchema>;

// §5.4.2 — one resource row changed. `data` is the row exactly as the matching
// GET list route serves it ("workers" ⇒ a GET /workers row); a remove carries at
// least { id } so the consumer can drop it.
export const PatchFrameSchema = z.object({
  t: z.literal("patch"),
  seq: z.number().int(),
  resource: z.enum(["workers", "pending"]),
  op: z.enum(["upsert", "remove"]),
  data: z.unknown(),
});
export type PatchFrame = z.infer<typeof PatchFrameSchema>;

// A block still streaming as `agent:delta` when the snapshot was taken: its text
// so far. Deltas are increments with no offset, so a device that missed some
// (backgrounded, reconnecting) re-seeds its live buffer from here instead of
// showing a hole.
export const LiveBlockSchema = z.object({
  workerId: z.string(),
  blockId: z.string(),
  channel: z.enum(["reasoning", "text"]),
  text: z.string(),
  // Finished streaming; its durable row is on the way.
  done: z.boolean().optional(),
});
export type LiveBlock = z.infer<typeof LiveBlockSchema>;

// §5.4.3 — full state re-seed, sent in answer to a client `hello` (resume /
// seq-gap recovery). Rows are the GET /workers + GET /pending list shapes.
// `epoch` names the bridge the seq belongs to — seq restarts with a new one, so
// a changed epoch means "reset your cursor", not "gap".
export const SnapshotFrameSchema = z.object({
  t: z.literal("snapshot"),
  seq: z.number().int(),
  epoch: z.string().optional(),
  workers: z.array(z.unknown()),
  pending: z.array(z.unknown()),
  live: z.array(LiveBlockSchema).optional(),
  caps: z.array(z.string()).optional(),
  // Only on the snapshot the Mac sends as soon as a phone joins: the GET /pty
  // sessions and GET /api/ui-config bodies, which the phone would otherwise
  // fetch one after the other before it shows anything.
  ptys: z.array(z.unknown()).optional(),
  uiConfig: z.unknown().optional(),
});
export type SnapshotFrame = z.infer<typeof SnapshotFrameSchema>;

// New transcript rows of the worker the phone has open (cap "rows"), in the
// GET /workers/:id/events row shape, oldest first. Right after a focus change a
// frame with no rows carries `live`: the text already streamed for the worker's
// in-flight blocks. Every later delta follows it, so it replaces what the
// phone's buffers hold for those blocks.
export const RowsFrameSchema = z.object({
  t: z.literal("rows"),
  seq: z.number().int(),
  workerId: z.string(),
  rows: z.array(z.unknown()),
  live: z.array(LiveBlockSchema).optional(),
});
export type RowsFrame = z.infer<typeof RowsFrameSchema>;

// ---- Server→client asset frame (binary out-of-band, §5.4.5) ----------------
// A binary route read (GET /fs/raw, /fs/image, /pdfjs) cannot ride the JSON
// `reply` frame: its bytes would be corrupted by the utf-8 round-trip the reply
// path performs. Such a response travels as base64 in this dedicated frame
// instead; the device base64-decodes `bytesB64` and serves the bytes to its
// WebView with `mime`. `correlationId` matches the originating control frame and
// `status` carries the captured HTTP status. This shape is FROZEN — the iOS
// asset scheme handler decodes it verbatim.
export const AssetFrameSchema = z.object({
  t: z.literal("asset"),
  correlationId: z.string(),
  status: z.number().int(),
  mime: z.string(),
  bytesB64: z.string(),
});
export type AssetFrame = z.infer<typeof AssetFrameSchema>;

// ---- Capability tiers + error codes (§5.5) ---------------------------------

export const RemoteTierSchema = z.enum(["READ", "LOW", "HIGH", "REFUSED"]);
export type RemoteTier = z.infer<typeof RemoteTierSchema>;

export const REMOTE_ERROR_CODES = [
  "BAD_VERSION",     // envelope ver mismatch (kept: outer header still versioned)
  "AUTH_REJECTED",   // relay BEARER_DENIED / room gone → NEEDS_PAIRING
  "CAP_DENIED",      // route not permitted remotely
  "ROUTE_REFUSED",   // route in the REFUSED set
  "RATE_LIMITED",
  "INTERNAL",
  "FRAME_TOO_LARGE",
] as const;
export const RemoteErrorCodeSchema = z.enum(REMOTE_ERROR_CODES);
export type RemoteErrorCode = z.infer<typeof RemoteErrorCodeSchema>;

// ---- Pairing QR payload v3 (plaintext relay) — produced by the Mac app ------
// Capability model: (relay, room, bearer) is the whole credential. No pinned
// static key, no enrollment token — the relay `join` bearer IS the credential.
export const PairingQrSchema = z.object({
  v: z.literal(3),
  typ: z.literal("eos-pair"),
  relay: z.string().url(),               // wss://… public relay endpoint
  room: z.string().min(43),              // b64url(>=32 bytes) — room capability + routing key
  bearer: z.string().min(43).optional(), // b64url(>=32 bytes) — room-join capability
  exp: z.number().int(),                 // unix seconds — QR display window close (UX guard)
});
export type PairingQr = z.infer<typeof PairingQrSchema>;
