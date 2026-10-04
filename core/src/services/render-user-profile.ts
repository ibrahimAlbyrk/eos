// renderUserProfile — the ONE place the user's profile and always-on memories become
// prompt text. The spawn chokepoint feeds it into {{USER_PROFILE}} (both preambles) and
// GET /api/profile/preview returns the same output, so "What agents see" can never
// drift from what agents actually get.
//
// - An empty profile with nothing to remember renders DEFAULT_USER_PREFERENCES — the
//   exact block the preambles hardcoded before profiles existed.
// - Structured lines and instructions always fit; memories fill the token budget
//   newest-first and the rest overflow into the "N more" hint.
// - Lines the session already receives elsewhere (`knownLines`, i.e. CLAUDE.md) are
//   dropped, so importing CLAUDE.md into the profile never doubles a rule.
// - User and agent text is data: one line per memory, the block's own tags neutralised.

import type {
  Autonomy, CommitPolicy, ExpertiseLevel, ReplyStyle, UserMemory, UserProfile, WhenUnclear, WorkRole,
} from "../../../contracts/src/profile.ts";
import { estimateTokens } from "../domain/compaction.ts";
import { isProfileEmpty } from "../domain/user-profile.ts";
import { memoriesInScope, newestFirst, normalizeMemoryText } from "../domain/user-memory.ts";

export const DEFAULT_USER_PREFERENCES = [
  "`<user_preferences>`",
  "",
  "The user has specified the following personal preferences for how Claude should respond:",
  "",
  "Be as concise and direct as possible. Limit unnecessary explanation and verbosity. A good test of whether your writing is concise is whether you can remove words and still get the same point across.",
  "",
  "Please keep these preferences in mind when responding.",
  "",
  "`</user_preferences>`",
].join("\n");

export interface RenderUserProfileOptions {
  readonly project: string | null;
  // Lines this session already gets from another source (CLAUDE.md).
  readonly knownLines?: readonly string[];
  // The memory search tool as this session names it; null → no "N more" hint.
  readonly searchToolName?: string | null;
}

export interface RenderedUserProfile {
  readonly text: string;
  readonly tokens: number;
  readonly includedIds: readonly string[];
  readonly overflow: number;
  readonly empty: boolean;
}

const ROLE: Record<WorkRole, string> = {
  engineering: "engineering", design: "design", product: "product",
  research: "research", data: "data", writing: "writing",
};

const LEVEL: Record<ExpertiseLevel, string> = {
  learning: "Expertise: learning — explain concepts and the reasoning behind them.",
  practitioner: "Expertise: practitioner — explain only what is not obvious.",
  expert: "Expertise: expert — skip the basics.",
};

const REPLIES: Record<ReplyStyle, string> = {
  terse: "Replies: terse — as short as possible, no filler.",
  balanced: "Replies: balanced — lead with the answer, add context only when it helps.",
  thorough: "Replies: thorough — explain reasoning, tradeoffs and next steps.",
};

const AUTONOMY: Record<Autonomy, string> = {
  ask: "Autonomy: ask before acting on anything non-trivial.",
  balanced: "Autonomy: act on routine steps; check in on big or irreversible calls.",
  run: "Autonomy: run with it and report decisions afterwards.",
};

const WHEN_UNCLEAR: Record<WhenUnclear, string> = {
  ask: "When something is unclear: ask before acting.",
  decide: "When something is unclear: make a reasonable call and state the assumption.",
};

const COMMITS: Record<CommitPolicy, string> = {
  "on-request": "Commits: only when the user asks.",
  milestones: "Commits: at meaningful milestones.",
};

const LANGUAGE: Record<string, string> = {
  ar: "Arabic", de: "German", en: "English", es: "Spanish", fr: "French", hi: "Hindi",
  it: "Italian", ja: "Japanese", ko: "Korean", nl: "Dutch", pl: "Polish", pt: "Portuguese",
  ru: "Russian", tr: "Turkish", uk: "Ukrainian", zh: "Chinese",
};

export function renderUserProfile(
  profile: UserProfile, memories: readonly UserMemory[], opts: RenderUserProfileOptions,
): RenderedUserProfile {
  const known = new Set((opts.knownLines ?? []).map(normalizeLine).filter(Boolean));
  const isKnown = (s: string): boolean => known.has(normalizeLine(s));
  const facts = isProfileEmpty(profile) ? [] : profileLines(profile);
  const instructions = dropKnownLines(profile.instructions, known);
  const inScope = memoriesInScope(memories, opts.project).filter((m) => !isKnown(m.text));
  const always = inScope.filter((m) => m.tier === "always").sort(globalFirstThenNewest);
  const onDemand = inScope.length - always.length;
  const hintable = Boolean(opts.searchToolName) && onDemand > 0;

  if (!facts.length && !instructions && !always.length && !hintable) {
    return { text: DEFAULT_USER_PREFERENCES, tokens: estimateTokens(DEFAULT_USER_PREFERENCES), includedIds: [], overflow: 0, empty: true };
  }

  const compose = (kept: readonly UserMemory[]): string =>
    composeBlock(facts, instructions, kept, always.length - kept.length + onDemand, opts.searchToolName ?? null);

  const kept: UserMemory[] = [];
  for (const m of always) {
    if (estimateTokens(compose([...kept, m])) > profile.budgetTokens) break;
    kept.push(m);
  }
  const text = compose(kept);
  return { text, tokens: estimateTokens(text), includedIds: kept.map((m) => m.id), overflow: always.length - kept.length, empty: false };
}

// Instruction lines minus the ones already known; outer blank lines trimmed.
export function dropKnownLines(text: string, known: ReadonlySet<string>): string {
  return sanitize(text)
    .split("\n")
    .filter((line) => !line.trim() || !known.has(normalizeLine(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function profileLines(p: UserProfile): string[] {
  const lines: string[] = [];
  const full = oneLine(p.identity.fullName);
  const call = oneLine(p.identity.callName);
  if (call) lines.push(full && full !== call ? `Address the user as "${call}" (full name: ${full}).` : `Address the user as "${call}".`);
  else if (full) lines.push(`The user's name is ${full}.`);
  if (p.work.roles.length) lines.push(`Works in: ${p.work.roles.map((r) => ROLE[r]).join(", ")}.`);
  if (p.work.level) lines.push(LEVEL[p.work.level]);
  if (p.work.stack.length) lines.push(`Stack: ${p.work.stack.map(oneLine).join(", ")}.`);
  if (p.language.chat) {
    lines.push(p.language.chat === "mirror"
      ? "Chat language: reply in the language the user writes in."
      : `Chat language: ${languageName(p.language.chat)}.`);
  }
  if (p.language.code) lines.push(`Code, commits and docs: ${languageName(p.language.code)}.`);
  if (p.style.replies) lines.push(REPLIES[p.style.replies]);
  if (p.style.autonomy) lines.push(AUTONOMY[p.style.autonomy]);
  if (p.style.whenUnclear) lines.push(WHEN_UNCLEAR[p.style.whenUnclear]);
  if (p.style.commits) lines.push(COMMITS[p.style.commits]);
  return lines;
}

function composeBlock(
  facts: readonly string[], instructions: string, kept: readonly UserMemory[], more: number, tool: string | null,
): string {
  const parts = ["`<user_profile>`"];
  if (facts.length) {
    parts.push("About the user — set by the user in Eos. Follow it unless the user says otherwise in the conversation.");
    parts.push(facts.map((l) => `- ${l}`).join("\n"));
  }
  if (instructions) parts.push("Standing instructions from the user:", instructions);
  if (kept.length) {
    parts.push("Remembered about the user:");
    parts.push(kept.map((m) => `- ${m.scope.kind === "project" ? "In this project: " : ""}${oneLine(m.text)}`).join("\n"));
  }
  if (tool && more > 0) {
    parts.push(`${more} more ${more === 1 ? "memory is" : "memories are"} available — call ${tool} when a task touches the user's preferences or conventions.`);
  }
  parts.push("`</user_profile>`");
  return parts.join("\n\n");
}

function globalFirstThenNewest(a: UserMemory, b: UserMemory): number {
  const rank = (m: UserMemory): number => (m.scope.kind === "global" ? 0 : 1);
  return rank(a) - rank(b) || newestFirst(a, b);
}

function languageName(code: string): string {
  const [base, ...rest] = code.split("-");
  const name = LANGUAGE[base];
  if (!name) return code;
  return rest.length ? `${name} (${code})` : name;
}

function oneLine(text: string): string {
  return sanitize(normalizeMemoryText(text));
}

// The block's own tags can't be opened or closed from inside user/agent text.
function sanitize(text: string): string {
  return text.replace(/<\s*\/?\s*user_(profile|preferences)\s*>/gi, "[user_$1]");
}

// Comparison key for "the same line": case, list markers, spacing and a trailing
// full stop don't matter.
function normalizeLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:]\s*$/, "")
    .trim()
    .toLowerCase();
}
