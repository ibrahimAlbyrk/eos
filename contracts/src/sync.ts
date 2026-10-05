// Sync (Settings › Sync) — the user's own data follows them to every Mac holding the
// same sync key: profile, avatar, memories, pages, prompt templates and worker
// definitions. Each Mac pushes its changes to an end-to-end encrypted vault on the
// relay and pulls everyone else's, so a Mac that is off catches up when it wakes.
// The relay sees only opaque blobs under opaque keys. Plan: docs/sync/00-SYNC-PLAN.md.

import { z } from "zod";

export const SyncDomainNameSchema = z.enum(["profile", "avatar", "memory", "page", "template", "worker"]);
export type SyncDomainName = z.infer<typeof SyncDomainNameSchema>;

// What travels inside one sealed vault record. `changedAt` decides which side wins
// when the same record changed on two Macs before either synced.
export const SyncEnvelopeSchema = z.object({
  v: z.literal(1),
  domain: SyncDomainNameSchema,
  id: z.string().min(1).max(200),
  changedAt: z.number(),
  device: z.string().max(200),
  deleted: z.literal(true).optional(),
  data: z.unknown().optional(),
});
export type SyncEnvelope = z.infer<typeof SyncEnvelopeSchema>;

// ---- relay vault wire (relay/vault/routes.ts) ---------------------------------

export const VaultEntryWireSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  seq: z.number().int().positive(),
  data: z.string(),
});
export type VaultEntryWire = z.infer<typeof VaultEntryWireSchema>;

export const VaultChangesWireSchema = z.object({
  head: z.number().int().nonnegative(),
  entries: z.array(VaultEntryWireSchema),
  more: z.boolean(),
});
export type VaultChangesWire = z.infer<typeof VaultChangesWireSchema>;

// ---- daemon API ---------------------------------------------------------------

export const SyncPhaseSchema = z.enum(["off", "idle", "syncing", "error"]);
export type SyncPhase = z.infer<typeof SyncPhaseSchema>;

export const SyncStatusResponseSchema = z.object({
  phase: SyncPhaseSchema,
  // Host of the relay holding the vault; null while off.
  relay: z.string().nullable(),
  lastSyncAt: z.number().nullable(),
  error: z.string().nullable(),
  // Records synced, per domain.
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type SyncStatusResponse = z.infer<typeof SyncStatusResponseSchema>;

export const SyncJoinRequestSchema = z.object({ key: z.string().trim().min(10).max(2000) });
export type SyncJoinRequest = z.infer<typeof SyncJoinRequestSchema>;

export const SyncKeyResponseSchema = z.object({ key: z.string() });
export type SyncKeyResponse = z.infer<typeof SyncKeyResponseSchema>;
