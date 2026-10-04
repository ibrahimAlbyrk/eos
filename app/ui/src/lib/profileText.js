// Pure profile helpers for the UI: display name, initials, the one-line subtitle,
// emptiness (mirrors core isProfileEmpty), patch merging for optimistic saves, and
// the per-target sharing switch.

import { LANGUAGE_OPTIONS, ROLE_OPTIONS, SHARE_TARGETS } from "./profileOptions.js";

export function displayName(profile) {
  const id = profile?.identity;
  return (id?.callName || id?.fullName || "").trim();
}

// Up to two letters from the full name (else the call name): "Ibrahim Albayrak" → "IA".
export function initials(profile) {
  const id = profile?.identity;
  const name = (id?.fullName || id?.callName || "").trim();
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toLocaleUpperCase()).join("");
}

const label = (options, value) => options.find((o) => o.value === value)?.label ?? value;

// "Engineering · Türkçe / English" — role first, then chat / code language.
export function profileSubtitle(profile) {
  if (!profile) return "";
  const parts = [];
  const role = profile.work.roles[0];
  if (role) parts.push(label(ROLE_OPTIONS, role));
  const langs = [profile.language.chat, profile.language.code]
    .filter((l) => l && l !== "mirror")
    .map((l) => label(LANGUAGE_OPTIONS, l));
  const unique = [...new Set(langs)];
  if (unique.length) parts.push(unique.join(" / "));
  return parts.join(" · ");
}

// Nothing an agent would hear (handle and avatar are display-only).
export function isProfileEmpty(profile) {
  if (!profile) return true;
  const { identity: i, language: l, work: w, style: s } = profile;
  return !i.fullName.trim() && !i.callName.trim() && !l.chat && !l.code
    && !w.roles.length && !w.stack.length && !w.level
    && !s.replies && !s.autonomy && !s.whenUnclear && !s.commits
    && !profile.instructions.trim();
}

// Groups merge one level deep, leaves replace — the daemon applies the same rule.
export function mergeProfilePatch(profile, patch) {
  const next = { ...profile };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...profile[key], ...value }
      : value;
  }
  return next;
}

export function isShared(profile, target) {
  const withheld = profile?.sharing.withholdFrom ?? [];
  return !target.kinds.some((k) => withheld.includes(k));
}

// The withholdFrom list with one target switched on or off.
export function withSharing(profile, targetId, shared) {
  const target = SHARE_TARGETS.find((t) => t.id === targetId);
  const rest = (profile?.sharing.withholdFrom ?? []).filter((k) => !target?.kinds.includes(k));
  return shared ? rest : [...rest, ...(target?.kinds ?? [])];
}
