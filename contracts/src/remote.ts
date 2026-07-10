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

export const HelloFrameSchema = z.object({
  t: z.literal("hello"),
  lastContentId: z.number().int().nonnegative().nullable().optional(),
});

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

export const ClientFrameSchema = z.discriminatedUnion("t", [
  HelloFrameSchema,
  ControlFrameSchema,
  KaFrameSchema,
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

// §5.4.3 — full state re-seed, sent in answer to a client `hello` (resume /
// seq-gap recovery). Rows are the GET /workers + GET /pending list shapes.
export const SnapshotFrameSchema = z.object({
  t: z.literal("snapshot"),
  seq: z.number().int(),
  workers: z.array(z.unknown()),
  pending: z.array(z.unknown()),
});
export type SnapshotFrame = z.infer<typeof SnapshotFrameSchema>;

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
