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
  body: z.unknown().optional(),
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

// ---- Capability tiers + error codes (§7.2, §8) -----------------------------

export const RemoteTierSchema = z.enum(["READ", "LOW", "HIGH", "REFUSED"]);
export type RemoteTier = z.infer<typeof RemoteTierSchema>;

export const REMOTE_ERROR_CODES = [
  "BAD_VERSION", "AUTH_FAILED", "DECRYPT_FAIL", "REPLAY", "SEQ_GAP",
  "TICKET_INVALID", "TICKET_REUSE", "STEPUP_REQUIRED", "STEPUP_INVALID",
  "CAP_DENIED", "ROUTE_REFUSED", "RATE_LIMITED", "INTERNAL", "FRAME_TOO_LARGE",
] as const;
export const RemoteErrorCodeSchema = z.enum(REMOTE_ERROR_CODES);
export type RemoteErrorCode = z.infer<typeof RemoteErrorCodeSchema>;

// ---- Handshake frames (§2) — carried as cleartext JSON in a type=0x01 outer
// envelope; the identity material inside encS/encC is AEAD-sealed. All b64u.

export const HsModeSchema = z.enum(["pair", "connect"]);
export type HsMode = z.infer<typeof HsModeSchema>;

// PAIR-1 / CONNECT-1 (device → Mac).
export const Hs1Schema = z.object({
  v: z.literal(1), t: z.literal("hs"), step: z.literal(1), mode: HsModeSchema,
  ePubC: z.string(), nC: z.string(),
});
// PAIR-2 / CONNECT-2 (Mac → device).
export const Hs2Schema = z.object({
  v: z.literal(1), t: z.literal("hs"), step: z.literal(2), mode: HsModeSchema,
  ePubS: z.string(), nS: z.string(), encS: z.string(),
});
// PAIR-3 / CONNECT-3 (device → Mac).
export const Hs3Schema = z.object({
  v: z.literal(1), t: z.literal("hs"), step: z.literal(3), mode: HsModeSchema,
  encC: z.string(),
});

// The sealed S2 (inside encS) and C3 (inside encC) plaintexts.
export const HsS2Schema = z.object({ iMac: z.string(), sigS: z.string() });
export const HsC3Schema = z.object({
  iDev: z.string(), devId: z.string(), label: z.string(), sigC: z.string(), ots: z.string(),
});

// RESUME (§2.3).
export const ResumeFrameSchema = z.object({
  v: z.literal(1), t: z.literal("resume"),
  ticketId: z.string(), ePubC: z.string(), nC: z.string(), binder: z.string(),
});

export type Hs1 = z.infer<typeof Hs1Schema>;
export type Hs2 = z.infer<typeof Hs2Schema>;
export type Hs3 = z.infer<typeof Hs3Schema>;
export type HsS2 = z.infer<typeof HsS2Schema>;
export type HsC3 = z.infer<typeof HsC3Schema>;
export type ResumeFrame = z.infer<typeof ResumeFrameSchema>;

// ---- Pairing QR payload (§6) — produced by the Mac app ---------------------

export const PairingQrSchema = z.object({
  v: z.literal(1),
  typ: z.literal("eos-pair"),
  macPub: z.string(),   // b64u of I_mac_pub, 65-byte SEC1
  ots: z.string(),      // b64u of 32-byte one-time pairing secret
  otsExp: z.number().int(),
  lan: z.array(z.string()),
  lanSpki: z.string().nullable().optional(),
  relay: z.object({ url: z.string(), room: z.string() }).nullable().optional(),
  bearer: z.string().nullable().optional(), // b64u of 32-byte one-time pairing bearer
  exp: z.number().int(),
});
export type PairingQr = z.infer<typeof PairingQrSchema>;
