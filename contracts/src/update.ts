// In-app updates. A signed pointer per platform names the newest release; its
// manifest lists the app bundle's tree, every file as content-defined chunks
// that live, zstd-compressed, in per-release packs. An installed app fetches
// only the chunks it lacks. Plan: docs/updates/00-UPDATES-PLAN.md.

import { z } from "zod";

export const UPDATE_FEED_URL = "https://updates.ibrahimalbyrk.dev";

// Ed25519 keys whose signature on a pointer is trusted (JWK `x`, base64url).
// More than one lets a new key be rolled out before the old one retires.
export const UPDATE_PUBLIC_KEYS: readonly string[] = ["XsyucF535SwQU0iA6UMdq52Pp7DEEL267ily0GBldQY"];

// The manifest format; changing how files are chunked is a new format.
export const UPDATE_MANIFEST_FORMAT = 1;

export const UPDATE_PLATFORMS = ["darwin-arm64", "win32-x64", "win32-arm64"] as const;
export const UpdatePlatformSchema = z.enum(UPDATE_PLATFORMS);
export type UpdatePlatform = z.infer<typeof UpdatePlatformSchema>;

// release.sh only tags major.minor.patch.
export const AppVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export type AppVersion = z.infer<typeof AppVersionSchema>;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
// A path inside the feed ("packs/darwin-arm64/0.1.3.pack"), never a URL.
const FeedPathSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "no dot segments");
const BundlePathSchema = z.string().min(1).max(4096);
const ModeSchema = z.number().int().min(0).max(0o777);
const SizeSchema = z.number().int().nonnegative();

// ---- pointer (stable/<platform>.json) ----------------------------------------

export const UpdatePointerSchema = z.object({
  version: AppVersionSchema,
  platform: UpdatePlatformSchema,
  manifest: z.object({ path: FeedPathSchema, sha256: Sha256Schema, size: z.number().int().positive() }),
  notes: FeedPathSchema.optional(),
  releasedAt: z.string().datetime(),
  // Where the feed lives from now on; an app that reads it keeps using it.
  feedUrl: z.string().url().startsWith("https://").optional(),
});
export type UpdatePointer = z.infer<typeof UpdatePointerSchema>;

// The pointer's JSON travels verbatim next to its Ed25519 signature, so what
// was signed is exactly what is parsed — no canonical form to agree on.
export const SignedUpdatePointerSchema = z.object({
  payload: z.string().min(2).max(16_384),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type SignedUpdatePointer = z.infer<typeof SignedUpdatePointerSchema>;

// ---- manifest (releases/<version>/<platform>.manifest.json.zst) ----------------

// A run of bytes in one of the manifest's packs: one zstd frame.
export const PackSpanSchema = z.object({
  pack: z.number().int().nonnegative(),
  offset: SizeSchema,
  zsize: z.number().int().positive(),
});
export type PackSpan = z.infer<typeof PackSpanSchema>;

export const UpdateChunkSchema = PackSpanSchema.extend({
  id: Sha256Schema,
  size: z.number().int().positive(),
});
export type UpdateChunk = z.infer<typeof UpdateChunkSchema>;

export const UpdateEntrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dir"), path: BundlePathSchema, mode: ModeSchema }),
  z.object({ type: z.literal("link"), path: BundlePathSchema, target: BundlePathSchema }),
  z.object({
    type: z.literal("file"),
    path: BundlePathSchema,
    mode: ModeSchema,
    size: SizeSchema,
    sha256: Sha256Schema,
    // Indexes into `chunks`, in file order.
    chunks: z.array(z.number().int().nonnegative()),
    // The file as one frame, when the publisher found its chunks compress
    // worse than the whole (a rewritten minified bundle).
    whole: PackSpanSchema.optional(),
  }),
]);
export type UpdateEntry = z.infer<typeof UpdateEntrySchema>;
export type UpdateFileEntry = Extract<UpdateEntry, { type: "file" }>;

export const UpdateManifestSchema = z.object({
  format: z.literal(UPDATE_MANIFEST_FORMAT),
  version: AppVersionSchema,
  platform: UpdatePlatformSchema,
  packs: z.array(FeedPathSchema),
  chunks: z.array(UpdateChunkSchema),
  entries: z.array(UpdateEntrySchema),
});
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;

// ---- what the daemon reports (/api/update, bus update:change) -----------------

export const UPDATE_PHASES = [
  "off", "idle", "checking", "available", "downloading", "staging", "ready", "waiting", "applying", "error",
] as const;
export const UpdatePhaseSchema = z.enum(UPDATE_PHASES);
export type UpdatePhase = z.infer<typeof UpdatePhaseSchema>;

// Why updates are off: a build made from source (eos build, npm start) is
// never replaced by a release; the system has no updater yet; or the app sits
// in a folder this user can't write to.
export const UpdateOffReasonSchema = z.enum(["dev-build", "platform", "read-only"]);
export type UpdateOffReason = z.infer<typeof UpdateOffReasonSchema>;

export const UpdateStatusSchema = z.object({
  phase: UpdatePhaseSchema,
  off: UpdateOffReasonSchema.nullable(),
  // The release being offered, downloaded or applied.
  version: AppVersionSchema.nullable(),
  // Bytes this update downloads, and how many of them are in.
  bytes: SizeSchema.nullable(),
  done: SizeSchema.nullable(),
  // What downloading the whole release would have cost — next to `bytes`, the
  // saving the beacon shows.
  full: SizeSchema.nullable(),
  // waiting: top-level agents still working.
  agents: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

// What the last restart into a new version came to: it opened, or it didn't and
// the previous version was put back.
export const UpdateNoticeSchema = z.object({
  kind: z.enum(["updated", "rolled-back"]),
  version: AppVersionSchema,
  from: AppVersionSchema,
});
export type UpdateNotice = z.infer<typeof UpdateNoticeSchema>;

// GET /api/update, and the payload of bus topic update:change.
export const UpdateStateSchema = z.object({
  // The installed version; null for a build from source.
  current: AppVersionSchema.nullable(),
  status: UpdateStatusSchema,
  lastCheckedAt: z.number().nullable(),
  autoDownload: z.boolean(),
  // The staged release's notes (markdown), once it is ready.
  notes: z.string().nullable(),
  notice: UpdateNoticeSchema.nullable(),
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UPDATE_TOPICS = { change: "update:change", apply: "update:apply" } as const;

// Bus topic update:apply — the daemon hands a verified staged bundle to the
// app, which quits and lets the applier swap it in.
export const UpdateApplySchema = z.object({
  version: AppVersionSchema,
  from: AppVersionSchema,
  staged: z.string().min(1),
  target: z.string().min(1),
});
export type UpdateApply = z.infer<typeof UpdateApplySchema>;

// POST /api/update/check — `manual` (Check now) always looks; Eos opening or the
// Mac waking looks unless a check ran a few minutes ago.
export const UpdateCheckTriggerSchema = z.enum(["manual", "opened", "woke"]);
export type UpdateCheckTrigger = z.infer<typeof UpdateCheckTriggerSchema>;
export const UpdateCheckRequestSchema = z.object({ trigger: UpdateCheckTriggerSchema.default("manual") }).strict();

// POST /api/update/restart — now, or as soon as no agent is working.
export const UpdateRestartRequestSchema = z.object({ when: z.enum(["now", "idle"]) }).strict();
export type UpdateRestartRequest = z.infer<typeof UpdateRestartRequestSchema>;

// PUT /api/settings/updates
export const UpdateSettingsPatchSchema = z.object({ autoDownload: z.boolean() }).partial().strict();
export type UpdateSettingsPatch = z.infer<typeof UpdateSettingsPatchSchema>;

// What the applier and the new app leave in ~/.eos/updates for each other.
export const UPDATE_FILES = {
  // The applier is waiting for this version to come up.
  pending: "apply.json",
  // The new app came up (its version inside).
  bootOk: "boot-ok",
  // How the last swap ended (UpdateNotice + `dismissed`).
  result: "result.json",
} as const;

// Resources/update.json — written only into release builds (release.sh sets
// EOS_UPDATE_CHANNEL); without it the app is a build from source and never
// updates itself.
export const UPDATE_BUILD_INFO_FILE = "update.json";
export const UpdateBuildInfoSchema = z.object({
  version: AppVersionSchema,
  channel: z.literal("stable"),
  platform: UpdatePlatformSchema,
});
export type UpdateBuildInfo = z.infer<typeof UpdateBuildInfoSchema>;
