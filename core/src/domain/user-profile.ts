// User profile rules — pure. The empty profile, applying a patch, and whether a
// profile says anything an agent should hear (an empty one renders the stock
// preferences, so a user who never opens Profile gets byte-identical prompts).

import {
  DEFAULT_DREAMING, PROFILE_BUDGET_DEFAULT, type AvatarExt, type UserProfile, type UserProfilePatch,
} from "../../../contracts/src/profile.ts";

export function emptyUserProfile(): UserProfile {
  return {
    rev: 0,
    updatedAt: 0,
    identity: { fullName: "", callName: "", handle: "", avatar: null },
    language: { chat: null, code: null },
    work: { roles: [], stack: [], level: null },
    style: { replies: null, autonomy: null, whenUnclear: null, commits: null },
    instructions: "",
    sharing: { withholdFrom: [] },
    budgetTokens: PROFILE_BUDGET_DEFAULT,
    onboardedAt: null,
    dreaming: { ...DEFAULT_DREAMING, excludedProjects: [] },
  };
}

// Handle and avatar are display-only; they never reach a prompt.
export function isProfileEmpty(p: UserProfile): boolean {
  const { identity: i, language: l, work: w, style: s } = p;
  return !i.fullName.trim() && !i.callName.trim()
    && !l.chat && !l.code
    && !w.roles.length && !w.stack.length && !w.level
    && !s.replies && !s.autonomy && !s.whenUnclear && !s.commits
    && !p.instructions.trim();
}

// Groups merge one level deep; leaves (arrays included) replace. rev/updatedAt are
// the service's to set.
export function applyProfilePatch(cur: UserProfile, patch: UserProfilePatch): UserProfile {
  return normalizeProfile({
    ...cur,
    identity: { ...cur.identity, ...patch.identity },
    language: { ...cur.language, ...patch.language },
    work: { ...cur.work, ...patch.work },
    style: { ...cur.style, ...patch.style },
    instructions: patch.instructions ?? cur.instructions,
    sharing: { ...cur.sharing, ...patch.sharing },
    budgetTokens: patch.budgetTokens ?? cur.budgetTokens,
    onboardedAt: patch.onboardedAt !== undefined ? patch.onboardedAt : cur.onboardedAt,
    dreaming: { ...cur.dreaming, ...patch.dreaming },
  });
}

// Same content, ignoring rev/updatedAt — a no-op save must not bump the revision.
export function sameProfileContent(a: UserProfile, b: UserProfile): boolean {
  return stableJson({ ...a, rev: 0, updatedAt: 0 }) === stableJson({ ...b, rev: 0, updatedAt: 0 });
}

// The image type from its magic bytes — never trust a declared content type.
export function sniffAvatarExt(bytes: Uint8Array): AvatarExt | null {
  const at = (i: number, ...sig: number[]): boolean => sig.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

function normalizeProfile(p: UserProfile): UserProfile {
  return {
    ...p,
    identity: {
      ...p.identity,
      fullName: p.identity.fullName.trim(),
      callName: p.identity.callName.trim(),
      handle: p.identity.handle.trim().replace(/^@/, ""),
    },
    work: { ...p.work, roles: unique(p.work.roles), stack: uniqueCaseless(p.work.stack.map((s) => s.trim()).filter(Boolean)) },
    sharing: { withholdFrom: unique(p.sharing.withholdFrom) },
    dreaming: { ...p.dreaming, excludedProjects: unique(p.dreaming.excludedProjects) },
  };
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function uniqueCaseless(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
