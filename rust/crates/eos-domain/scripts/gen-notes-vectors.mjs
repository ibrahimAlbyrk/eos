// Vectors for the Rust port of the page, user-memory and user-profile rules:
// inputs and what the TypeScript (core/src/domain/page.ts, user-memory.ts,
// user-profile.ts, dream.ts' lintMemoryText) returns for them.
//
//   node rust/crates/eos-domain/scripts/gen-notes-vectors.mjs
//
// Needs Node ≥ 23.6 (runs the .ts sources directly) and `npm ci` in contracts/.
// Inputs are seeded, so a run writes the same files until the TypeScript changes.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const { applyPageEdit, pageExcerpt, pageTaskCounts } = await import(join(REPO, "core/src/domain/page.ts"));
const memory = await import(join(REPO, "core/src/domain/user-memory.ts"));
const profile = await import(join(REPO, "core/src/domain/user-profile.ts"));
const { lintMemoryText } = await import(join(REPO, "core/src/domain/dream.ts"));

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261111);
const int = (n) => Math.floor(rand() * n);
const pick = (xs) => xs[int(xs.length)];
const chance = (p) => rand() < p;
const some = (xs, max) => Array.from({ length: int(max + 1) }, () => pick(xs));

// A string Rust can hold: no lone surrogate.
const wellFormed = (v) => JSON.stringify(v) === JSON.stringify(JSON.parse(JSON.stringify(v))) && !/\\ud[89a-f]/i.test(JSON.stringify(v));

// ---- pages ------------------------------------------------------------------

const WORDS = [
  "probe", "Ground", "clamp", "hip", "offset", "stairs", "blend", "IK", "weight", "çalışma", "İstanbul", "naïve",
  "東京", "notes", "the", "solver", "pure", "*bold*", "_em_", "`code`", "~~gone~~", "😀", "a", "e", "task", "Tasks",
  "ΟΔΟΣ", "x", "1.", "2)", ">", "-", "#", "[ ]", "[x]",
];
const phrase = (max = 6) => Array.from({ length: 1 + int(max) }, () => pick(WORDS)).join(pick([" ", " ", " ", "  ", "\t", " "]));
const TITLES = ["Tasks", "Notes", "Later", "tasks", "Çalışma Notları", "Next steps", "A  B", "IK"];

function line() {
  const indent = pick(["", "", "", " ", "  ", "\t", "    "]);
  switch (int(16)) {
    case 0: return `${pick(["#", "##", "###", "######", "#######"])}${pick([" ", "  ", "\t", ""])}${pick(TITLES)}${pick(["", "", " #", " ##  ", "#"])}`;
    case 1: return `${indent}${pick(["-", "*", "+"])} [${pick([" ", "x", "X"])}] ${phrase()}`;
    case 2: return `${indent}${pick(["-", "*", "+"])}${pick([" ", "  "])}[${pick([" ", "x", "X", "", "y"])}]${pick([" ", "", "\t"])}${phrase(3)}`;
    case 3: return `${indent}${pick(["```", "~~~", "```md", "~~~~", "````"])}`;
    case 4: return `${indent}${pick(["-", "*", "+"])} ${phrase()}`;
    case 5: return `${indent}${1 + int(12)}${pick([".", ")"])} ${phrase()}`;
    case 6: return `${pick([">", "> ", " >  "])}${phrase()}`;
    case 7: return "";
    case 8: return pick(["", " ", "\t", " "]);
    case 9: return `${phrase(12)}${pick(["", "", "\r", " ", "."])}`;
    case 10: return `${indent}- [ ] ${phrase(2)}\r`;
    case 11: return `## ${pick(TITLES)}`;
    case 12: return `- [ ] ${pick(["write changelog", "announce", "Announce the release", "tag", "ship  it"])}`;
    default: return phrase(9);
  }
}
const body = (max = 14) => Array.from({ length: int(max + 1) }, line).join("\n") + pick(["", "\n", "\n\n", " \n"]);

const pages = [];
const BODIES = [
  "", "\n", "# Title\n\n- [ ] first *thing*\n> quoted", "x".repeat(300), "- [ ] a\n", "para\n",
  "## Tasks\n\n- [ ] a\n\n## Next\n", "b b", "a b c", "😀".repeat(100), `${"ab ".repeat(52)}😀😀😀 tail`,
  "```\n- [ ] in fence\n```\n- [x] out\n~~~\n## h\n```\n~~~\n## real\n",
];
for (let i = 0; i < 260; i++) BODIES.push(body());
for (let i = 0; i < 40; i++) BODIES.push(body(60));

function edit(b) {
  const lines = b.split("\n");
  switch (int(3)) {
    case 0: {
      const text = pick([phrase(), `- [ ] ${phrase(3)}`, `\n\n${phrase()}\n\n`, "1. one\n2. two", " ", "\n", `  ${phrase(2)}  `, "- item"]);
      const heading = chance(0.7)
        ? pick([...TITLES, `## ${pick(TITLES)}`, "#Tasks", "###  Notes", "nope", "not a heading", pick(lines).replace(/^#+\s*/, "").trim() || "Later"]).trim()
        : undefined;
      return heading ? { op: "append", text, heading } : { op: "append", text };
    }
    case 1: {
      const from = int(Math.max(1, [...b].length));
      const cut = [...b].slice(from, from + 1 + int(12)).join("");
      const oldText = chance(0.8) && cut ? cut : pick(["not on the page", "a", " ", "\n", "- [ ]"]);
      return { op: "replace", oldText, newText: pick(["", "NEW", phrase(2), "\n"]) };
    }
    default: {
      const tasks = lines.map((l) => l.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.*)$/)?.[1]).filter(Boolean);
      const base = tasks.length && chance(0.8) ? pick(tasks) : pick(["announce", "e", "a", "nothing like it", "- [ ] tag", "- [x]"]);
      const task = (chance(0.4) ? base.slice(0, 1 + int(base.length)) : chance(0.3) ? base.toUpperCase() : base).trim() || "a";
      return { op: "setTask", task, done: chance(0.5) };
    }
  }
}
// One vector per body: its counts, excerpts and a few edits.
for (const b of BODIES) {
  const excerpts = [];
  for (const max of [160, pick([1, 2, 10, 40, 159])]) {
    const out = pageExcerpt(b, max);
    if (wellFormed(out)) excerpts.push({ max, out });
  }
  const edits = [];
  for (let i = 0; i < 4; i++) {
    const e = edit(b);
    if (!wellFormed(e)) continue;
    try {
      edits.push({ edit: e, ok: applyPageEdit(b, e) });
    } catch (err) {
      edits.push({ edit: e, err: err.message });
    }
  }
  pages.push({ body: b, counts: pageTaskCounts(b), excerpts, edits });
}

// ---- memories ---------------------------------------------------------------

const TEXTS = [
  "Be concise, always.", "always be CONCISE", "Use tabs", "Use spaces", "Write commits in English.",
  "write commits in english", "Run lint before tests.", "Prefers pnpm over npm.", "Commit messages in English, terse.",
  "Never restart the daemon.", "Pending npm thing.", "When fixing a bug, find the root cause before changing code.",
  "Before posting on GitHub, show the draft and wait for approval.", "The user builds games in Unity.",
  "Prefers minimal, airy UI.", "When committing, usually split the changes.", "When committing, NEVER push.",
  "İstanbul'da çalışırken Türkçe yaz.", "istanbul'da çalışırken türkçe yaz", "ΟΔΟΣ ΟΔΟΥΣ οδός", "東京 で 作業 する とき",
  "हिन्दी में लिखो कृपया", "في العمل اكتب بالعربية", "a b c d", "a", "1 22 333", "tabs-vs-spaces: tabs!", "x_y z9 №5 ½ Ⅳ ⓐ",
  "𝒜 𝒜𝒷 ab", "😀 emoji only 😀", "If asked twice, the user tends to want a list.", "While reviewing, be Often blunt.",
  "After tests pass it is IMPORTANT to commit.", "The users like tabs.", "Whenever.", "", "  ", "When x y do z",
  "line one\nline two", "Uses   many    spaces\tand tabs", "When using npm, prefer pnpm scripts over npm run.",
];
const text = () => (chance(0.6) ? pick(TEXTS) : `${pick(["When", "Before", "The user", "Prefers", "If"])} ${phrase(8)} ${pick(TEXTS)}`).trim();
const PATHS = ["/Users/me/eos", "/Users/me/eos/app", "/Users/me/eos-old", "/x", "/x/", "/x//", "/"];
const scope = () => (chance(0.6) ? { kind: "global" } : { kind: "project", path: pick(PATHS) });
const project = () => (chance(0.3) ? null : pick([...PATHS, "/x/y", "/Users/me/eos/app/ui", ""]));

let seq = 0;
const memId = (n) => `um-${String(n).padStart(8, "0")}`;
function mem(pool) {
  seq += 1;
  const m = {
    id: memId(seq),
    text: text() || "x",
    category: pick(["about", "work-style", "stack", "other"]),
    ...(chance(0.4) ? { domain: pick(["communication", "planning", "code", "ui", "testing", "debugging", "git", "tools", "about"]) } : {}),
    scope: scope(),
    tier: pick(["always", "always", "on-demand"]),
    status: pick(["active", "active", "active", "suggested", "dismissed"]),
    source: { kind: "user" },
    rev: int(4),
    createdAt: 1000 + int(50),
    updatedAt: 1000 + int(50),
  };
  if (m.status !== "active" && chance(0.5) && pool.length) {
    m.proposal = { kind: pick(["new", "update", "merge", "promote", "retire"]), targets: some(pool, 3).map((p) => p.id) };
  }
  return m;
}
const memories = () => {
  const pool = [];
  for (let i = 0, n = int(9); i < n; i++) pool.push(mem(pool));
  return pool;
};

const mems = [];
for (const t of TEXTS) {
  mems.push({ kind: "normalize", text: t, out: memory.normalizeMemoryText(t) });
  mems.push({ kind: "lint", text: t, out: lintMemoryText(t) });
}
for (let i = 0; i < 60; i++) {
  const t = `${pick(["When x,", "The user", "Before"])} ${"word ".repeat(30 + int(15))}${pick(["", "usually", "MUST", "Always"])}`;
  mems.push({ kind: "lint", text: t, out: lintMemoryText(t) });
}
for (let i = 0; i < 400; i++) {
  const [a, b] = [text(), chance(0.3) ? pick(TEXTS) : text()];
  mems.push({ kind: "similarity", a, b, out: memory.memorySimilarity(a, b) });
}
for (const path of PATHS) {
  for (const p of [...PATHS, "/x/y", "/Users/me/eos/app/ui", "", null]) {
    mems.push({ kind: "covers", scope: { kind: "project", path }, project: p, out: memory.scopeCovers({ kind: "project", path }, p) });
  }
}
// One vector per pool: a duplicate check, a proposal check, a search, a scope filter.
for (let i = 0; i < 300; i++) {
  const pool = memories();
  const t = chance(0.5) && pool.length ? pick(pool).text : text();
  const s = chance(0.5) && pool.length ? pick(pool).scope : scope();
  const kept = pool.filter((m) => m.status === "active");
  const proposal = chance(0.5) && pool.some((m) => m.proposal)
    ? pick(pool.filter((m) => m.proposal)).proposal
    : { kind: pick(["update", "merge", "promote", "retire"]), targets: some(kept.length ? kept : [{ id: memId(0) }], 3).map((m) => m.id) };
  const query = pick(["", " ", "npm commit", "restart daemon", "tabs", "TÜRKÇE", "co", t, phrase(3)]);
  const p = project();
  const limit = pick([1, 2, 5, 8, 20]);
  mems.push({
    kind: "pool", pool, text: t, scope: s, proposal, query, project: p, limit,
    duplicate: memory.findDuplicateMemory(t, s, pool)?.id ?? null,
    duplicateProposal: memory.findDuplicateProposal(t, proposal, pool)?.id ?? null,
    search: memory.searchMemories(pool, query, p, limit).map((m) => m.id),
    inScope: memory.memoriesInScope(pool, p).map((m) => m.id),
  });
}

// ---- profiles ---------------------------------------------------------------

const NAMES = ["", " ", "Ibrahim", "  Ibo ", "Sam Example", "@sam", "@@sam", " @ibo ", "Ünal "];
const STACKS = ["Bun", "bun", " Node ", "", "  ", "TypeScript", "typescript", "Rust", "İOS", "i̇os", "React"];
const LANGS = [null, "tr", "en", "mirror", "pt-BR"];
function patch() {
  const p = {};
  if (chance(0.5)) {
    p.identity = {};
    if (chance(0.6)) p.identity.fullName = pick(NAMES);
    if (chance(0.6)) p.identity.callName = pick(NAMES);
    if (chance(0.6)) p.identity.handle = pick(NAMES);
  }
  if (chance(0.3)) p.language = { ...(chance(0.6) ? { chat: pick(LANGS) } : {}), ...(chance(0.6) ? { code: pick(LANGS) } : {}) };
  if (chance(0.5)) {
    p.work = {};
    if (chance(0.6)) p.work.roles = some(["engineering", "design", "product", "research", "data", "writing"], 5);
    if (chance(0.6)) p.work.stack = some(STACKS, 6);
    if (chance(0.4)) p.work.level = pick([null, "learning", "practitioner", "expert"]);
  }
  if (chance(0.3)) {
    p.style = {};
    if (chance(0.5)) p.style.replies = pick([null, "terse", "balanced", "thorough"]);
    if (chance(0.5)) p.style.autonomy = pick([null, "ask", "balanced", "run"]);
    if (chance(0.5)) p.style.whenUnclear = pick([null, "ask", "decide"]);
    if (chance(0.5)) p.style.commits = pick([null, "on-request", "milestones"]);
  }
  if (chance(0.3)) p.instructions = pick(["", "  ", "Be brief.", " Use pnpm.\n", " "]);
  if (chance(0.3)) p.sharing = chance(0.8) ? { withholdFrom: some(["codex", "gemini", "codex", "openai"], 4) } : {};
  if (chance(0.3)) p.budgetTokens = pick([200, 800, 4000]);
  if (chance(0.3)) p.onboardedAt = pick([null, 5, 1791180846770]);
  if (chance(0.3)) {
    p.dreaming = {};
    if (chance(0.5)) p.dreaming.enabled = chance(0.5);
    if (chance(0.5)) p.dreaming.schedule = pick(["nightly", "away", "manual"]);
    if (chance(0.5)) p.dreaming.nightlyAt = pick(["03:00", "23:59"]);
    if (chance(0.5)) p.dreaming.awayMinutes = pick([5, 20, 240]);
    if (chance(0.5)) p.dreaming.model = pick(["opus", "sonnet", "haiku"]);
    if (chance(0.5)) p.dreaming.maxChats = pick([1, 20, 60]);
    if (chance(0.5)) p.dreaming.usageCeiling = pick([0.1, 0.7, 1, 0.35]);
    if (chance(0.5)) p.dreaming.excludedProjects = some(["/a", "/b", "/a"], 4);
    if (chance(0.5)) p.dreaming.includeNoFolder = chance(0.5);
    if (chance(0.5)) p.dreaming.morningNote = chance(0.5);
  }
  return p;
}

// A chain: each patch applies to the previous result (`reset` starts again from
// the empty profile), as saves do.
const profiles = [];
let cur = profile.emptyUserProfile();
profiles.push({ kind: "empty", out: cur });
for (let i = 0; i < 400; i++) {
  const reset = chance(0.1);
  if (reset) cur = profile.emptyUserProfile();
  const p = patch();
  const next = profile.applyProfilePatch(cur, p);
  profiles.push({
    kind: "patch", reset, patch: p, out: next,
    same: profile.sameProfileContent(cur, next), empty: profile.isProfileEmpty(next),
  });
  cur = next;
}

const write = (name, vectors) => {
  writeFileSync(join(HERE, "../tests/fixtures", name), `${JSON.stringify({ vectors })}\n`);
  console.log(`${name}: ${vectors.length} vectors`);
};
write("page-vectors.json", pages);
write("user-memory-vectors.json", mems);
write("user-profile-vectors.json", profiles);
