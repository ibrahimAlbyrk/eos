// File transfer between paired Macs (the Transfer tab, and the focused agent's
// send_to_machine tool). Every daemon serves the same small endpoint (/transfer/*)
// over its own disk; the engine that moves bytes runs on the Mac the user sits at
// and drives two endpoints — its own in-process, a paired host's over the link.
// Plan: docs/transfer/00-TRANSFER-PLAN.md.

import { z } from "zod";

export const TRANSFER_ID_RE = /^tr-[a-z0-9]{8,32}$/;
export const TransferIdSchema = z.string().regex(TRANSFER_ID_RE);

// A chunk never exceeds this — one PUT / one read request.
export const TRANSFER_MAX_CHUNK = 16 * 1024 * 1024;
// One transfer's file count ceiling; past it the user zips first.
export const TRANSFER_MAX_ITEMS = 100_000;

// "local" = this Mac; otherwise a paired host's fingerprint.
export const MachineRefSchema = z.union([z.literal("local"), z.string().regex(/^[0-9a-f]{64}$/)]);
export type MachineRef = z.infer<typeof MachineRefSchema>;

const AbsPathSchema = z.string().min(1).max(4096).refine((p) => p.startsWith("/") && !p.includes("\0"), "absolute path required");

// ---- endpoint wire (/transfer/*, every daemon) --------------------------------

export const TransferErrorCodeSchema = z.enum([
  "bad-path", "not-found", "forbidden-dest", "duplicate-name", "too-many", "source-changed",
  "offset-mismatch", "no-space", "conflict-unresolved", "incomplete", "unreachable", "needs-update", "forbidden",
]);
export type TransferErrorCode = z.infer<typeof TransferErrorCodeSchema>;

export const TransferErrorBodySchema = z.object({
  error: z.string(),
  code: TransferErrorCodeSchema,
  // offset-mismatch: how many bytes the receiving side already holds.
  have: z.number().int().nonnegative().optional(),
});
export type TransferErrorBody = z.infer<typeof TransferErrorBodySchema>;

export const TransferListEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory"]),
  isSymlink: z.boolean(),
  // Files only — a folder's size needs a walk, so it comes with a scan.
  size: z.number().int().nonnegative().nullable(),
  mtimeMs: z.number(),
});
export type TransferListEntry = z.infer<typeof TransferListEntrySchema>;

export const TransferListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  home: z.string(),
  entries: z.array(TransferListEntrySchema),
});
export type TransferListing = z.infer<typeof TransferListingSchema>;

export const ManifestItemTypeSchema = z.enum(["file", "dir", "link"]);
export type ManifestItemType = z.infer<typeof ManifestItemTypeSchema>;

// One entry under a selected item. `rel` starts with the selected item's own
// name ("NeonDrift.app/Contents/Info.plist"), so the roots are the first segments.
export const ManifestItemSchema = z.object({
  rel: z.string().min(1).max(4096),
  type: ManifestItemTypeSchema,
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  mode: z.number().int().min(0).max(0o777),
  target: z.string().max(4096).optional(),
});
export type ManifestItem = z.infer<typeof ManifestItemSchema>;

export const TransferRootSchema = z.object({
  name: z.string(),
  type: ManifestItemTypeSchema,
  // Bytes under it (a file: its size).
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
});
export type TransferRoot = z.infer<typeof TransferRootSchema>;

export const TransferManifestSchema = z.object({
  roots: z.array(TransferRootSchema),
  items: z.array(ManifestItemSchema).max(TRANSFER_MAX_ITEMS),
  totalBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
});
export type TransferManifest = z.infer<typeof TransferManifestSchema>;

export const TransferScanRequestSchema = z.object({ paths: z.array(AbsPathSchema).min(1).max(500) });

export const TransferPrepareRequestSchema = z.object({
  id: TransferIdSchema,
  destDir: AbsPathSchema,
  items: z.array(ManifestItemSchema).min(1).max(TRANSFER_MAX_ITEMS),
});
export type TransferPrepareRequest = z.infer<typeof TransferPrepareRequestSchema>;

// What already sits where a root would land.
export const TransferExistingSchema = z.object({
  name: z.string(),
  type: ManifestItemTypeSchema,
  size: z.number().int().nonnegative().nullable(),
  mtimeMs: z.number(),
});
export type TransferExisting = z.infer<typeof TransferExistingSchema>;

export const TransferPrepareResultSchema = z.object({
  existing: z.array(TransferExistingSchema),
  // Bytes already staged per file rel (a resumed transfer picks up from here).
  staged: z.record(z.string(), z.number().int().nonnegative()),
  freeBytes: z.number().nonnegative(),
});
export type TransferPrepareResult = z.infer<typeof TransferPrepareResultSchema>;

export const TransferDecisionSchema = z.enum(["replace", "keep", "skip"]);
export type TransferDecision = z.infer<typeof TransferDecisionSchema>;

export const TransferCommitRequestSchema = z.object({
  id: TransferIdSchema,
  destDir: AbsPathSchema,
  decisions: z.record(z.string(), TransferDecisionSchema),
});
export type TransferCommitRequest = z.infer<typeof TransferCommitRequestSchema>;

export const TransferPlacedSchema = z.object({ name: z.string(), path: z.string() });
export type TransferPlaced = z.infer<typeof TransferPlacedSchema>;

export const TransferCommitResultSchema = z.object({
  placed: z.array(TransferPlacedSchema),
  skipped: z.array(z.string()),
});
export type TransferCommitResult = z.infer<typeof TransferCommitResultSchema>;

export const TransferAbortRequestSchema = z.object({ id: TransferIdSchema, destDir: AbsPathSchema });

export const TransferKeyRequestSchema = z.object({ path: AbsPathSchema });
export const TransferKeyResponseSchema = z.object({ key: z.string().nullable() });
export const TransferLocateRequestSchema = z.object({ key: z.string().min(1).max(2000) });
export const TransferLocateResponseSchema = z.object({ path: z.string().nullable() });

// ---- this Mac's engine (/api/transfers, local-only) ----------------------------

export const TransferStatusSchema = z.enum([
  "queued", "scanning", "copying", "conflict", "committing",
  "paused", "interrupted", "done", "failed", "cancelled",
]);
export type TransferStatus = z.infer<typeof TransferStatusSchema>;

export const TransferRouteSchema = z.enum(["local", "direct", "relay", "reverse"]);
export type TransferRoute = z.infer<typeof TransferRouteSchema>;

export const TransferConflictSchema = z.object({
  name: z.string(),
  existing: TransferExistingSchema.omit({ name: true }),
  incoming: TransferRootSchema.omit({ name: true }),
});
export type TransferConflict = z.infer<typeof TransferConflictSchema>;

export const TransferOriginSchema = z.object({
  kind: z.enum(["user", "agent"]),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
});
export type TransferOrigin = z.infer<typeof TransferOriginSchema>;

export const TransferRecordSchema = z.object({
  id: TransferIdSchema,
  from: MachineRefSchema,
  to: MachineRefSchema,
  origin: TransferOriginSchema,
  sources: z.array(z.string()),
  destDir: z.string(),
  destReason: z.enum(["project", "default", "chosen"]),
  status: TransferStatusSchema,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  roots: z.array(TransferRootSchema),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  doneBytes: z.number().int().nonnegative(),
  // Bytes per second, smoothed; 0 when not copying.
  rate: z.number().nonnegative(),
  route: TransferRouteSchema.nullable(),
  conflicts: z.array(TransferConflictSchema),
  decisions: z.record(z.string(), TransferDecisionSchema),
  placed: z.array(TransferPlacedSchema),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type TransferRecord = z.infer<typeof TransferRecordSchema>;

export const TransferStartRequestSchema = z.object({
  from: MachineRefSchema,
  to: MachineRefSchema,
  paths: z.array(AbsPathSchema).min(1).max(500),
  // null/absent: the same project on the other Mac, else ~/Downloads/Eos there.
  destDir: AbsPathSchema.nullable().optional(),
}).refine((r) => r.from !== r.to, "pick two different computers");
export type TransferStartRequest = z.infer<typeof TransferStartRequestSchema>;

export const TransferDecideRequestSchema = z.object({ decisions: z.record(z.string(), TransferDecisionSchema) });

export const TransferDestinationRequestSchema = z.object({
  from: MachineRefSchema,
  to: MachineRefSchema,
  paths: z.array(AbsPathSchema).min(1).max(500),
});
export const TransferDestinationResponseSchema = z.object({
  destDir: z.string(),
  reason: z.enum(["project", "default"]),
});
export type TransferDestinationResponse = z.infer<typeof TransferDestinationResponseSchema>;

export const TransferListResponseSchema = z.object({ transfers: z.array(TransferRecordSchema) });

// SSE "transfer:change": one transfer's new state, or ids cleared from the list.
export const TransferChangeEventSchema = z.object({
  transfer: TransferRecordSchema.optional(),
  removed: z.array(z.string()).optional(),
});
export type TransferChangeEvent = z.infer<typeof TransferChangeEventSchema>;

// ---- a focused agent sending files (/workers/:id/transfers, local-only) ----------

export const AgentTransferRequestSchema = z.object({
  // A paired Mac's name or alias, as the user said it ("MacBook Air").
  machine: z.string().trim().min(1).max(200),
  // Absolute, or relative to the agent's folder.
  paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
});
export type AgentTransferRequest = z.infer<typeof AgentTransferRequestSchema>;
