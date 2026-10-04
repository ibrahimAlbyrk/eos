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

// suggested = waiting for the user; dismissing deletes it.
export const UserMemoryStatusSchema = z.enum(["active", "suggested"]);
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
]);
export type UserMemorySource = z.infer<typeof UserMemorySourceSchema>;

const MemoryTextSchema = z.string().trim().min(1).max(USER_MEMORY_TEXT_MAX);

export const UserMemorySchema = z.object({
  id: UserMemoryIdSchema,
  text: MemoryTextSchema,
  category: UserMemoryCategorySchema,
  scope: UserMemoryScopeSchema,
  tier: UserMemoryTierSchema,
  status: UserMemoryStatusSchema,
  source: UserMemorySourceSchema,
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
  scope: UserMemoryScopeSchema,
  tier: UserMemoryTierSchema.default("always"),
});
export type UserMemoryCreateRequest = z.infer<typeof UserMemoryCreateRequestSchema>;

export const UserMemoryUpdateRequestSchema = z.object({
  text: MemoryTextSchema.optional(),
  category: UserMemoryCategorySchema.optional(),
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

// duplicate: an equivalent memory (kept or pending) already existed and is returned instead.
export const UserMemorySuggestResponseSchema = z.object({
  memory: UserMemorySchema,
  duplicate: z.boolean(),
});
export type UserMemorySuggestResponse = z.infer<typeof UserMemorySuggestResponseSchema>;

// SSE `user-memory:change` payload.
export const UserMemoryChangeEventSchema = z.object({
  id: UserMemoryIdSchema,
  action: z.enum(["created", "updated", "approved", "dismissed", "deleted"]),
  status: UserMemoryStatusSchema,
  by: z.enum(["user", "agent"]),
});
export type UserMemoryChangeEvent = z.infer<typeof UserMemoryChangeEventSchema>;
