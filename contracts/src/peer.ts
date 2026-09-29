// Eos ↔ Eos peering contracts: controlling another computer's Eos as if local.
//
// Vocabulary: the "host" is the Mac being controlled (serves its API to paired
// devices); a "device" is a computer allowed to control this host. Every Eos is
// both: it may host (Settings › Remote access) and it may control hosts
// (the Machines menu). Identity = a self-signed cert; `id`/`fp` = its SHA-256
// fingerprint (64 hex), `deviceId` = the short human form.

import { z } from "zod";

export const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected a 64-hex certificate fingerprint");

// ---- config.peer — hosting (who may control THIS Mac). OFF by default ----
export const PeerConfigSchema = z.object({
  enabled: z.boolean(),
  // Direct connections from this network (LAN / Tailnet). Off ⇒ relay only.
  direct: z.boolean(),
  port: z.number().int().min(1).max(65535),
  // Display name shown to other devices; absent ⇒ the computer name.
  name: z.string().trim().min(1).max(64).optional(),
  // Extra direct addresses put first in invites — a tailnet name
  // ("office-imac.tail1234.ts.net"), a port-forwarded DNS name. "host" alone
  // means the listening port.
  advertise: z.array(z.string().trim().min(1).max(255)).max(8).optional(),
  // The relay other computers reach this Mac through when no direct path
  // works (wss://). Absent ⇒ the iPhone relay (config.remote.relay.url), if any.
  relayUrl: z.string().url().optional(),
});
export type PeerConfig = z.infer<typeof PeerConfigSchema>;

export const PeerUpdateRequestSchema = PeerConfigSchema.partial().strict();
export type PeerUpdateRequest = z.infer<typeof PeerUpdateRequestSchema>;

// ---- GET /api/host — who this daemon is ----------------------------------
export const HostInfoSchema = z.object({
  id: FingerprintSchema,
  deviceId: z.string(),
  name: z.string(),
  platform: z.string(),
  // The daemon user's home, so a controlling UI can shorten paths correctly.
  home: z.string(),
  // Hash of the HTTP contract surface; a UI bundle only talks to a daemon with
  // the same stamp (or loads that daemon's own UI).
  apiStamp: z.string(),
  // Whether GET /ui/* serves this daemon's own dashboard bundle.
  servesUi: z.boolean(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

// ---- invites (host side mints, device side redeems) ----------------------
// Carried out of band as `eos://pair/<base64url(JSON)>`. The secret is single
// use and does not expire — it may be redeemed a day later on another network —
// until used or cancelled on the host; `fp` lets the device refuse an impostor
// before it sends the secret anywhere.
export const PEER_INVITE_PREFIX = "eos://pair/";

export const PeerInviteSchema = z.object({
  v: z.literal(1),
  fp: FingerprintSchema,
  sec: z.string().min(22),
  name: z.string().min(1).max(64),
  // Direct candidates, "host:port" (IPv6 bracketed).
  addrs: z.array(z.string().min(3)).max(12),
  relay: z.object({ url: z.string().url(), room: z.string().min(43) }).optional(),
  // Unix seconds. Only links from builds that expired invites carry it.
  exp: z.number().int().optional(),
});
export type PeerInvite = z.infer<typeof PeerInviteSchema>;

export const InviteResponseSchema = z.object({
  link: z.string(),
  deviceId: z.string(),
});

// An invite still open on the host, persisted (hashes only) so it outlives a
// restart. `joinHash` admits the redeeming device to the relay room.
export const OpenInviteSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  joinHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number(),
});
export type OpenInvite = z.infer<typeof OpenInviteSchema>;
export type InviteResponse = z.infer<typeof InviteResponseSchema>;

// POST /peer/pair — reachable ONLY over the secure channel by a not-yet-paired
// device; the device's identity is taken from its TLS certificate, never the body.
export const PairRequestSchema = z.object({
  secret: z.string().min(22),
  name: z.string().trim().min(1).max(64),
  platform: z.string().max(32),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  host: HostInfoSchema,
  // Per-device relay admission, present when the host is reachable via a relay.
  relay: z.object({ url: z.string().url(), room: z.string(), bearer: z.string() }).optional(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

// ---- host side: devices allowed to control this Mac ----------------------
export const PairedDeviceSchema = z.object({
  fp: FingerprintSchema,
  name: z.string(),
  platform: z.string(),
  pairedAt: z.number(),
  lastSeenAt: z.number().nullable(),
  // SHA-256 of this device's relay bearer (the relay stores only hashes).
  relayBearerHash: z.string().optional(),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

export const PairedDeviceViewSchema = PairedDeviceSchema.omit({ relayBearerHash: true }).extend({
  deviceId: z.string(),
  connected: z.boolean(),
});
export type PairedDeviceView = z.infer<typeof PairedDeviceViewSchema>;

export const PeerStatusSchema = z.object({
  enabled: z.boolean(),
  direct: z.boolean(),
  port: z.number().int(),
  listening: z.boolean(),
  host: HostInfoSchema,
  // Where other devices can reach this Mac directly right now.
  addrs: z.array(z.string()),
  relay: z.object({ url: z.string(), online: z.boolean() }).nullable(),
  // Invite links made here and not yet used or cancelled.
  openInvites: z.number().int(),
  devices: z.array(PairedDeviceViewSchema),
});
export type PeerStatus = z.infer<typeof PeerStatusSchema>;

// ---- device side: hosts this Mac controls --------------------------------
export const LinkStateSchema = z.enum(["connecting", "live", "reconnecting", "offline", "unauthorized", "incompatible"]);
export type LinkState = z.infer<typeof LinkStateSchema>;

export const LinkRouteSchema = z.enum(["direct", "relay"]);
export type LinkRoute = z.infer<typeof LinkRouteSchema>;

export const LinkStatusSchema = z.object({
  state: LinkStateSchema,
  route: LinkRouteSchema.nullable(),
  rttMs: z.number().nullable(),
  since: z.number(),
  attempt: z.number().int(),
  error: z.string().nullable(),
});
export type LinkStatus = z.infer<typeof LinkStatusSchema>;

// Persisted under ~/.eos/peer/hosts.json (0600) — carries the relay bearer.
export const KnownHostSchema = z.object({
  id: FingerprintSchema,
  name: z.string(),
  alias: z.string().nullable(),
  platform: z.string(),
  addrs: z.array(z.string()),
  relay: z.object({ url: z.string().url(), room: z.string(), bearer: z.string() }).optional(),
  pairedAt: z.number(),
  lastConnectedAt: z.number().nullable(),
});
export type KnownHost = z.infer<typeof KnownHostSchema>;

// What GET /api/hosts returns — secrets stripped, live link state added.
export const HostViewSchema = KnownHostSchema.omit({ relay: true }).extend({
  deviceId: z.string(),
  hasRelay: z.boolean(),
  link: LinkStatusSchema,
  info: HostInfoSchema.nullable(),
});
export type HostView = z.infer<typeof HostViewSchema>;

export const ConnectHostRequestSchema = z.object({
  invite: z.string().min(PEER_INVITE_PREFIX.length + 10),
  alias: z.string().trim().max(64).optional(),
});
export type ConnectHostRequest = z.infer<typeof ConnectHostRequestSchema>;

export const UpdateHostRequestSchema = z.object({
  alias: z.string().trim().max(64).nullable().optional(),
  addrs: z.array(z.string().min(3)).max(12).optional(),
}).strict();
export type UpdateHostRequest = z.infer<typeof UpdateHostRequestSchema>;

// Headers the host's gateway sets on every proxied request; a device can
// never supply them (the gateway overwrites).
export const PEER_DEVICE_HEADER = "x-eos-peer-device";
// Set by the controlling device's facade when ITS local caller presented its
// ui-token (the human dashboard, not an on-box agent). Only then does the
// host's gateway attach its own ui-token — the human/agent split survives the hop.
export const PEER_HUMAN_HEADER = "x-eos-peer-human";

// Why a host turned a device away (HTTP/2 GOAWAY opaque data). A device stops
// retrying on these instead of looping as if the network were down.
export const PEER_REFUSAL = {
  notPaired: "not-paired",
  hostingOff: "remote-access-off",
} as const;
export type PeerRefusal = (typeof PEER_REFUSAL)[keyof typeof PEER_REFUSAL];
