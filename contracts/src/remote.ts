// iOS remote-control contracts — config shape, the E2E inner-frame shapes the
// daemon validates on the wire, and the pairing-QR payload. The byte-exact
// crypto/wire details live in docs/ios-remote-protocol.md; this file is the
// single source of truth for the JSON shapes the daemon parses/produces.

import { z } from "zod";

// ---- config.remote (design §6.1) — OFF by default --------------------------

export const RemoteModeSchema = z.enum(["off", "lan", "relay"]);
export type RemoteMode = z.infer<typeof RemoteModeSchema>;

// The remote edge is the /ws gateway only. In `lan` mode the daemon's main
// server binds a routable interface (the loopback-lock middleware keeps every
// non-/ws surface off-box); in `relay` mode the daemon dials out and registers
// a room. Secrets (Mac static key, per-device keyring, relay owner secret) do
// NOT live here — they are files under ~/.eos managed by the keyring module.
export const RemoteConfigSchema = z.object({
  mode: RemoteModeSchema,
  // LAN-direct exposure. `host` is the bind address for the gateway when
  // mode=lan (e.g. "0.0.0.0" or a specific LAN IP). Absent/loopback ⇒ no
  // off-box exposure even with mode=lan.
  lan: z
    .object({ host: z.string() })
    .partial()
    .optional(),
  // Self-hosted relay (Mode B). `url` is the public wss endpoint; `room` is the
  // b64u(16-byte) routing key the QR also carries.
  relay: z
    .object({ url: z.string(), room: z.string() })
    .partial()
    .optional(),
  // Auto-expiring inactivity lease (design §4.6): remote auto-disarms after
  // this many ms of no remote activity. 0 = no lease (stays armed).
  inactivityLeaseMs: z.number().int().nonnegative().optional(),
  // Gateway rate limits (design §4.6). Pairing is throttled hardest.
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

// ---- Inner frames the daemon RECEIVES (client → server, §4.2) --------------
// The daemon decrypts a data frame to one UTF-8 JSON object and validates it
// here before dispatch. Server→client frames (event/patch/snapshot/reply/ka/
// challenge/error) are daemon-produced and typed below for the emitter.

export const HelloFrameSchema = z.object({
  t: z.literal("hello"),
  lastContentId: z.number().int().nonnegative().nullable().optional(),
  resumptionTicket: z.string().optional(),
  resumeEphemeralPub: z.string().optional(),
});

// A high-risk control frame carries a step-up (§7.3). challengeNonce/ts/sig are
// b64u/decimal as defined in the protocol; the daemon verifies the Enclave sig.
export const StepUpSchema = z.object({
  challengeNonce: z.string(),
  ts: z.number().int(),
  sig: z.string(),
});
export type StepUp = z.infer<typeof StepUpSchema>;

export const ControlFrameSchema = z.object({
  t: z.literal("control"),
  correlationId: z.string().uuid(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string(),
  // body is an OPAQUE JSON STRING on the wire (§3.4) — NOT a nested object — so
  // the step-up bodyHash is over the exact transmitted bytes with no
  // re-serialization. GET ⇒ "{}". Absent ⇒ treated as "{}".
  body: z.string().optional(),
  stepUp: StepUpSchema.optional(),
});
export type ControlFrame = z.infer<typeof ControlFrameSchema>;

export const KaFrameSchema = z.object({ t: z.literal("ka"), ts: z.number().int() });

export const ClientFrameSchema = z.discriminatedUnion("t", [
  HelloFrameSchema,
  ControlFrameSchema,
  KaFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ---- Server→client asset frame (binary out-of-band, design §4 / C6) --------
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

// ---- Capability tiers + error codes (§7.2, §8) -----------------------------

export const RemoteTierSchema = z.enum(["READ", "LOW", "HIGH", "REFUSED"]);
export type RemoteTier = z.infer<typeof RemoteTierSchema>;

export const REMOTE_ERROR_CODES = [
  "BAD_VERSION", "AUTH_FAILED", "AUTH_REJECTED", "DECRYPT_FAIL", "REPLAY", "SEQ_GAP",
  "CAP_DENIED", "ROUTE_REFUSED", "RATE_LIMITED", "INTERNAL", "FRAME_TOO_LARGE",
] as const;
export const RemoteErrorCodeSchema = z.enum(REMOTE_ERROR_CODES);
export type RemoteErrorCode = z.infer<typeof RemoteErrorCodeSchema>;

// ---- Pairing QR payload (connection v2 §5.2) — produced by the Mac app ------
// The handshake itself is the binary Noise_IK message set (docs/ios-remote-
// connection-v2.md), NOT JSON frames — it rides as the opaque payload of a
// type=0x01 data envelope, so the relay never inspects it and there are no
// per-leg JSON schemas. The QR is the one human-scanned artifact: it pins the
// Mac static X25519 key and carries a one-time enrollment token.

export const PairingQrSchema = z.object({
  v: z.literal(2),
  typ: z.literal("eos-pair"),
  macStatic: z.string(), // b64u of the Mac static X25519 public key (32B), pinned
  enroll: z.string(),    // b64u one-time enrollment token (also the relay-admission value during pairing)
  lan: z.array(z.string()),
  lanSpki: z.string().nullable().optional(),
  relay: z.object({ url: z.string(), room: z.string() }).nullable().optional(),
  exp: z.number().int(), // unix seconds — enrollment window close
});
export type PairingQr = z.infer<typeof PairingQrSchema>;
