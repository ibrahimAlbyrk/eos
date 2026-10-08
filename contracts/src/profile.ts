// Profile & memory (Settings › Profile, the Memory view) — who the user is, as every
// agent sees it. One profile per daemon (~/.eos/profile/profile.json) plus discrete
// memories (~/.eos/profile/memories/<id>.md); both are user data, so `restart --db`
// never wipes them. Agents only ever SUGGEST a memory — keeping, editing and deleting
// are the user's (ui-token routes). core/src/services/render-user-profile.ts turns the
// profile plus the always-on memories into the block every spawned agent gets.
//
// Names: `UserProfile*` / `UserMemory*` on purpose — `Memory*` already means Claude
// Code's own file memory and CLAUDE.md (http.ts, memory.ts, config.memory).

import { z } from "zod";

export const PROFILE_NAME_MAX = 120;
export const PROFILE_CALL_NAME_MAX = 60;
export const PROFILE_HANDLE_MAX = 40;
export const PROFILE_STACK_MAX = 40;
export const PROFILE_INSTRUCTIONS_MAX = 4000;
export const PROFILE_BUDGET_MIN = 200;
export const PROFILE_BUDGET_MAX = 4000;
export const PROFILE_BUDGET_DEFAULT = 800;
export const USER_MEMORY_TEXT_MAX = 500;
export const USER_MEMORY_WHY_MAX = 300;

// ---- profile ----------------------------------------------------------------

export const WorkRoleSchema = z.enum(["engineering", "design", "product", "research", "data", "writing"]);
export type WorkRole = z.infer<typeof WorkRoleSchema>;

export const ExpertiseLevelSchema = z.enum(["learning", "practitioner", "expert"]);
export type ExpertiseLevel = z.infer<typeof ExpertiseLevelSchema>;

export const ReplyStyleSchema = z.enum(["terse", "balanced", "thorough"]);
export type ReplyStyle = z.infer<typeof ReplyStyleSchema>;

export const AutonomySchema = z.enum(["ask", "balanced", "run"]);
export type Autonomy = z.infer<typeof AutonomySchema>;

export const WhenUnclearSchema = z.enum(["ask", "decide"]);
export type WhenUnclear = z.infer<typeof WhenUnclearSchema>;

export const CommitPolicySchema = z.enum(["on-request", "milestones"]);
export type CommitPolicy = z.infer<typeof CommitPolicySchema>;

// A BCP-47-ish language code ("tr", "en", "pt-BR"); for chat also "mirror" = answer
// in whatever language the user writes in.
export const ProfileLanguageSchema = z.string().regex(/^(mirror|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/, "invalid language");

export const AvatarExtSchema = z.enum(["png", "jpeg", "webp"]);
export type AvatarExt = z.infer<typeof AvatarExtSchema>;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const StackItemSchema = z.string().trim().min(1).max(PROFILE_STACK_MAX);

// ---- dreaming settings + proposal primitives ----------------------------------
// Dreaming: while the user is away, Eos rereads finished chats and files memory
// proposals for the morning review (contracts/src/dream.ts holds the runs). The
// settings ride on the profile so they share its one write path and SSE.

export const DreamScheduleSchema = z.enum(["nightly", "away", "manual"]);
export type DreamSchedule = z.infer<typeof DreamScheduleSchema>;

export const DreamModelSchema = z.enum(["opus", "sonnet", "haiku"]);
export type DreamModel = z.infer<typeof DreamModelSchema>;

export const DreamingSettingsSchema = z.object({
  enabled: z.boolean(),
  schedule: DreamScheduleSchema,
  nightlyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM"),
  awayMinutes: z.number().int().min(5).max(240),
  model: DreamModelSchema,
  maxChats: z.number().int().min(1).max(60),
  // Plan usage (0–1) at or above which a dream holds off until the next night.
  usageCeiling: z.number().min(0.1).max(1),
  excludedProjects: z.array(z.string().min(1)).max(200),
  includeNoFolder: z.boolean(),
  morningNote: z.boolean(),
});
export type DreamingSettings = z.infer<typeof DreamingSettingsSchema>;

export const DEFAULT_DREAMING: DreamingSettings = {
  enabled: false,
  schedule: "nightly",
  nightlyAt: "03:00",
  awayMinutes: 20,
  model: "opus",
  maxChats: 20,
  usageCeiling: 0.7,
  excludedProjects: [],
  includeNoFolder: true,
  morningNote: true,
};

// new = a memory agents don't have · update = a kept memory drifted · merge = kept
// memories overlap · promote = a project memory holds everywhere · retire = no longer true.
export const DreamProposalKindSchema = z.enum(["new", "update", "merge", "promote", "retire"]);
export type DreamProposalKind = z.infer<typeof DreamProposalKindSchema>;

// The exact message a proposal rests on, so the review can quote and link to it.
export const DreamEvidenceSchema = z.object({
  quote: z.string().max(400),
  workerId: z.string().min(1),
  chat: z.string(),
  eventId: z.number().int().nullable(),
  by: z.enum(["user", "agent"]),
});
export type DreamEvidence = z.infer<typeof DreamEvidenceSchema>;

// Every preference is nullable: null = not set, so the renderer leaves that line out
// instead of asserting a default the user never chose.
export const UserProfileSchema = z.object({
  rev: z.number().int().nonnegative(),
  updatedAt: z.number(),
  identity: z.object({
    fullName: z.string().max(PROFILE_NAME_MAX),
    callName: z.string().max(PROFILE_CALL_NAME_MAX),
    handle: z.string().max(PROFILE_HANDLE_MAX),
    // Extension of ~/.eos/profile/avatar.<ext>; set only through the avatar route.
    avatar: AvatarExtSchema.nullable(),
  }),
  language: z.object({
    chat: ProfileLanguageSchema.nullable(),
    code: ProfileLanguageSchema.nullable(),
  }),
  work: z.object({
    roles: z.array(WorkRoleSchema).max(6),
    stack: z.array(StackItemSchema).max(PROFILE_STACK_MAX),
    level: ExpertiseLevelSchema.nullable(),
  }),
  style: z.object({
    replies: ReplyStyleSchema.nullable(),
    autonomy: AutonomySchema.nullable(),
    whenUnclear: WhenUnclearSchema.nullable(),
    commits: CommitPolicySchema.nullable(),
  }),
  // Eos-owned standing instructions, delivered to every lane. CLAUDE.md is never written.
  instructions: z.string().max(PROFILE_INSTRUCTIONS_MAX),
  // Backend kinds that never receive the profile or the memory tools — data, the same
  // shape as config.memory's assumeNativeFor; no code branches on a kind.
  sharing: z.object({ withholdFrom: z.array(z.string().min(1)).max(32) }),
  // Token budget of the rendered block; memories past it overflow to on-demand.
  budgetTokens: z.number().int().min(PROFILE_BUDGET_MIN).max(PROFILE_BUDGET_MAX),
  onboardedAt: z.number().nullable(),
  // Defaulted so a profile.json written before Dreaming still loads.
  dreaming: DreamingSettingsSchema.default(DEFAULT_DREAMING),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

const P = UserProfileSchema.shape;

// A patch replaces whole leaves (arrays included); groups merge one level deep. The
// avatar is not patchable here — it changes with its bytes (PUT/DELETE avatar).
export const UserProfilePatchSchema = z.object({
  identity: P.identity.omit({ avatar: true }).partial().strict().optional(),
  language: P.language.partial().strict().optional(),
  work: P.work.partial().strict().optional(),
  style: P.style.partial().strict().optional(),
  instructions: P.instructions.optional(),
  sharing: P.sharing.partial().strict().optional(),
  budgetTokens: P.budgetTokens.optional(),
  onboardedAt: P.onboardedAt.optional(),
  dreaming: DreamingSettingsSchema.partial().strict().optional(),
}).strict();
export type UserProfilePatch = z.infer<typeof UserProfilePatchSchema>;

export const UserProfileUpdateRequestSchema = z.object({
  patch: UserProfilePatchSchema,
  baseRev: z.number().int().nonnegative().optional(),
});
export type UserProfileUpdateRequest = z.infer<typeof UserProfileUpdateRequestSchema>;

export const UserProfileResponseSchema = z.object({ profile: UserProfileSchema });
export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;

// Exactly what a spawn of `kind` in `project` would get — the same renderer, so the
// "What agents see" panel can never drift from the real prompt.
export const UserProfilePreviewSchema = z.object({
  text: z.string(),
  tokens: z.number().int().nonnegative(),
  budgetTokens: z.number().int(),
  includedMemoryIds: z.array(z.string()),
  overflow: z.number().int().nonnegative(),
  withheld: z.boolean(),
});
export type UserProfilePreview = z.infer<typeof UserProfilePreviewSchema>;

// Read-only copy of the user-level CLAUDE.md for "Import from CLAUDE.md".
export const ClaudeMdImportResponseSchema = z.object({
  path: z.string().nullable(),
  text: z.string(),
});
export type ClaudeMdImportResponse = z.infer<typeof ClaudeMdImportResponseSchema>;

// SSE `profile:change` payload.
export const UserProfileChangeEventSchema = z.object({
  rev: z.number().int().nonnegative(),
});
export type UserProfileChangeEvent = z.infer<typeof UserProfileChangeEventSchema>;

// ---- memories ---------------------------------------------------------------

export const UserMemoryIdSchema = z.string().regex(/^um-[a-z0-9]{8,32}$/, "invalid memory id");

export const UserMemoryCategorySchema = z.enum(["about", "work-style", "stack", "other"]);
export type UserMemoryCategory = z.infer<typeof UserMemoryCategorySchema>;

// The area of work a memory's situation belongs to — the prompt block groups by it.
// Optional: a memory without one renders under "Other".
export const UserMemoryDomainSchema = z.enum([
  "communication", "planning", "code", "ui", "testing", "debugging", "git", "tools", "about",
]);
export type UserMemoryDomain = z.infer<typeof UserMemoryDomainSchema>;

// A project memory renders only for sessions inside `path` (an absolute folder;
// worktrees resolve to their source repo).
export const UserMemoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("project"), path: z.string().min(1) }),
]);
export type UserMemoryScope = z.infer<typeof UserMemoryScopeSchema>;

// always = rendered into every matching prompt (within budget); on-demand = found
// through search_memory when a task touches it.
export const UserMemoryTierSchema = z.enum(["always", "on-demand"]);
export type UserMemoryTier = z.infer<typeof UserMemoryTierSchema>;

// suggested = waiting for the user · dismissed = a tombstone: never rendered or
// listed, kept only so the same idea is never suggested again.
export const UserMemoryStatusSchema = z.enum(["active", "suggested", "dismissed"]);
export type UserMemoryStatus = z.infer<typeof UserMemoryStatusSchema>;

// Who produced the memory. Open for new producers: a background reviewer adds its own
// kind here without touching storage, approval or the UI's grouping.
export const UserMemorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({
    kind: z.literal("agent"),
    agentId: z.string().min(1),
    agentName: z.string(),
    why: z.string().max(USER_MEMORY_WHY_MAX).optional(),
  }),
  z.object({ kind: z.literal("import"), from: z.string().min(1) }),
  z.object({
    kind: z.literal("dream"),
    dreamId: z.string().min(1),
    evidence: z.array(DreamEvidenceSchema).max(8),
    // What goes wrong for an agent that doesn't know it.
    why: z.string().max(USER_MEMORY_WHY_MAX).optional(),
  }),
]);
export type UserMemorySource = z.infer<typeof UserMemorySourceSchema>;

// How far a dream's proposal is backed: separate chats, days and projects it was
// seen in, and whether the user said it as a standing rule (explicit) or it was
// inferred from repeats.
export const DreamSupportSummarySchema = z.object({
  chats: z.number().int().nonnegative(),
  days: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  origin: z.enum(["explicit", "inferred"]),
});
export type DreamSupportSummary = z.infer<typeof DreamSupportSummarySchema>;

// What keeping a suggestion does (a dream's proposal). Absent = a plain new memory.
// `confidence` is the first dreams' 1–3 score; newer proposals carry `support`.
export const UserMemoryProposalSchema = z.object({
  kind: DreamProposalKindSchema,
  targets: z.array(UserMemoryIdSchema).max(6),
  confidence: z.number().int().min(1).max(3).optional(),
  support: DreamSupportSummarySchema.optional(),
});
export type UserMemoryProposal = z.infer<typeof UserMemoryProposalSchema>;

const MemoryTextSchema = z.string().trim().min(1).max(USER_MEMORY_TEXT_MAX);

export const UserMemorySchema = z.object({
  id: UserMemoryIdSchema,
  text: MemoryTextSchema,
  category: UserMemoryCategorySchema,
  domain: UserMemoryDomainSchema.optional(),
  scope: UserMemoryScopeSchema,
  tier: UserMemoryTierSchema,
  status: UserMemoryStatusSchema,
  source: UserMemorySourceSchema,
  proposal: UserMemoryProposalSchema.optional(),
  rev: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type UserMemory = z.infer<typeof UserMemorySchema>;

export const UserMemoryListResponseSchema = z.object({ memories: z.array(UserMemorySchema) });
export type UserMemoryListResponse = z.infer<typeof UserMemoryListResponseSchema>;

export const UserMemoryResponseSchema = z.object({ memory: UserMemorySchema });
export type UserMemoryResponse = z.infer<typeof UserMemoryResponseSchema>;

// The user writes one directly (kept immediately).
export const UserMemoryCreateRequestSchema = z.object({
  text: MemoryTextSchema,
  category: UserMemoryCategorySchema,
  domain: UserMemoryDomainSchema.optional(),
  scope: UserMemoryScopeSchema,
  tier: UserMemoryTierSchema.default("always"),
});
export type UserMemoryCreateRequest = z.infer<typeof UserMemoryCreateRequestSchema>;

export const UserMemoryUpdateRequestSchema = z.object({
  text: MemoryTextSchema.optional(),
  category: UserMemoryCategorySchema.optional(),
  domain: UserMemoryDomainSchema.optional(),
  scope: UserMemoryScopeSchema.optional(),
  tier: UserMemoryTierSchema.optional(),
  baseRev: z.number().int().nonnegative().optional(),
});
export type UserMemoryUpdateRequest = z.infer<typeof UserMemoryUpdateRequestSchema>;

// An agent proposes one. "project" resolves server-side to the caller's session
// project — an agent never names a path.
export const UserMemorySuggestRequestSchema = z.object({
  text: MemoryTextSchema,
  category: UserMemoryCategorySchema,
  scope: z.enum(["global", "project"]),
  why: z.string().trim().max(USER_MEMORY_WHY_MAX).optional(),
});
export type UserMemorySuggestRequest = z.infer<typeof UserMemorySuggestRequestSchema>;

// duplicate: an equivalent memory already existed and is returned instead ·
// declined: that memory is one the user dismissed — don't suggest it again.
export const UserMemorySuggestResponseSchema = z.object({
  memory: UserMemorySchema,
  duplicate: z.boolean(),
  declined: z.boolean(),
});
export type UserMemorySuggestResponse = z.infer<typeof UserMemorySuggestResponseSchema>;

// SSE `user-memory:change` payload. by "sync" = arrived from another Mac.
export const UserMemoryChangeEventSchema = z.object({
  id: UserMemoryIdSchema,
  action: z.enum(["created", "updated", "approved", "dismissed", "deleted"]),
  status: UserMemoryStatusSchema,
  by: z.enum(["user", "agent", "dream", "sync"]),
});
export type UserMemoryChangeEvent = z.infer<typeof UserMemoryChangeEventSchema>;
