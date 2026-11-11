// Vectors for the file stores: what today's stores write for a page, a memory
// and a profile, and what they read back from hand-made files.
//
//   node rust/crates/eos-store-files/scripts/gen-store-vectors.mjs
//
// Needs Node ≥ 23.6 and `npm ci` in contracts/ and infra/. Inputs are seeded.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const { parsePage, serializePage } = await import(join(REPO, "infra/src/persistence/FilePageStore.ts"));
const { parseUserMemory, serializeUserMemory } = await import(join(REPO, "infra/src/persistence/FileUserMemoryStore.ts"));
const { PageSchema } = await import(join(REPO, "contracts/src/http.ts"));
const { UserMemorySchema, UserProfileSchema } = await import(join(REPO, "contracts/src/profile.ts"));
const { applyProfilePatch, emptyUserProfile } = await import(join(REPO, "core/src/domain/user-profile.ts"));

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(7);
const int = (n) => Math.floor(rand() * n);
const pick = (xs) => xs[int(xs.length)];
const chance = (p) => rand() < p;

const TEXTS = [
  "", "Notes", "Stance: notes — \"quoted\"", "3D branch reviews", "123", "1.5", "true", "null", "~", "yes", "No",
  " leading space", "trailing space ", "- dash first", "# hash", "key: value", "a #comment", "'single'", "\"double\"",
  "çalışma notları İ", "東京 notes 😀", "tab\there", "line one\nline two", "line one\n\nline three\n", "ends with colon:",
  "[brackets]", "{braces}", "@at", "`tick`", "!bang", "%percent", "&anchor", "*star", "|pipe", ">gt", "?question",
  "2026-11-11", "0x1f", "1e3", "+1", ".5", "-", "---", "--- not a fence", "a".repeat(79), "b".repeat(81),
  `${"word ".repeat(30)}end`, `${"long-unbroken-".repeat(12)}`, "quote \" and backslash \\ and tab\t", "\u00a0nbsp", "emoji 👩‍💻 zwj",
  "When committing: split changes; never push --force.",
  // Scalars a YAML 1.1 reader takes for something else than the string they are.
  "0b11", "-0b1", "-0x1f", "+0x1F", "0o17", "-0o7", "+0o7", "1_000", "0.1_0", "NaN", "inf", "Infinity", "-.inf", ".NAN",
  "010", "-010", "+010", "0x", "1e", "y", "n", "on", "Off", "=", "<<", "!!str x", "1:30", "190:20:30", "-1:30:00.5",
  "2001-12-14t21:59:43.10-05:00", "TRUE", "Null", "NULL", "0.", ".e3", "1.e3", "0x_1", "00", "-0", "+.5", "1,000", "0o8", "ends with space \nnext", "a\r\nb", "\u2028line sep", "para\u2029sep end\u2029", "del\u007f", "nel\u0085 c1\u009f", "bom\ufeffinside", "bell\u0007",
];
const text = () => pick(TEXTS);
const PATHS = [null, "/Users/me/dear souls", "/Users/me/eos", "/p", "C:\\work\\x", "/Users/me/ünï/çöde: x"];
const AUTHORS = [
  { kind: "user", agentId: null, name: null },
  { kind: "agent", agentId: "w-1", name: "Stance IK" },
  { kind: "agent", agentId: "w-abc12345", name: null },
  { kind: "agent", agentId: "o-x1y2z3", name: "Fix: the \"parser\"" },
];
const BODIES = [
  "", "\n", "one line", "one line\n", "---\nnot frontmatter\n---\n\n- [ ] task\n", "# Title\r\n\r\nwindows\r\n",
  "\n\nleading blank lines", "   indented", "---", "---\n", "a\n---\nb", "😀\n", "tab\tseparated\n",
];
const ts = () => pick([0, 1, 2, 1791180846770, 1791181518420, 1.5]);
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[int(16)]).join("");

function page() {
  return {
    id: `pg-${hex(pick([8, 12, 12, 32]))}`,
    title: text().slice(0, 200),
    body: chance(0.6) ? pick(BODIES) : `${text()}\n\n${text()}\n`,
    project: pick(PATHS),
    agentId: pick([null, "w-abc12345", "o-x1y2z3"]),
    rev: pick([0, 1, 3, 250]),
    createdAt: ts(),
    updatedAt: ts(),
    updatedBy: pick(AUTHORS),
  };
}

const memText = () => (text().trim() || "x").slice(0, 500);
const evidence = () => ({
  quote: text().slice(0, 400),
  workerId: pick(["w-abc12345", "o-x1y2z3"]),
  chat: text(),
  eventId: pick([null, 0, 42, 100200]),
  by: pick(["user", "agent"]),
});
function source() {
  switch (int(4)) {
    case 0: return { kind: "user" };
    case 1: return { kind: "agent", agentId: "w-abc12345", agentName: text(), ...(chance(0.6) ? { why: text().slice(0, 300) } : {}) };
    case 2: return { kind: "import", from: pick(["claude-md", "/Users/me/.claude/CLAUDE.md"]) };
    default: return {
      kind: "dream", dreamId: `dr-${hex(12)}`,
      evidence: Array.from({ length: int(4) }, evidence),
      ...(chance(0.6) ? { why: text().slice(0, 300) } : {}),
    };
  }
}
function proposal() {
  return {
    kind: pick(["new", "update", "merge", "promote", "retire"]),
    targets: Array.from({ length: int(4) }, () => `um-${hex(12)}`),
    ...(chance(0.4) ? { confidence: 1 + int(3) } : {}),
    ...(chance(0.6) ? { support: { chats: int(9), days: int(9), projects: int(4), firstSeen: ts(), lastSeen: ts(), origin: pick(["explicit", "inferred"]) } } : {}),
  };
}
function memory() {
  return {
    id: `um-${hex(pick([8, 12, 12, 32]))}`,
    text: memText(),
    category: pick(["about", "work-style", "stack", "other"]),
    ...(chance(0.5) ? { domain: pick(["communication", "planning", "code", "ui", "testing", "debugging", "git", "tools", "about"]) } : {}),
    scope: chance(0.6) ? { kind: "global" } : { kind: "project", path: pick(PATHS.slice(1)) },
    tier: pick(["always", "on-demand"]),
    status: pick(["active", "suggested", "dismissed"]),
    source: source(),
    ...(chance(0.4) ? { proposal: proposal() } : {}),
    rev: pick([0, 1, 7]),
    createdAt: ts(),
    updatedAt: ts(),
  };
}

const pages = [];
for (let i = 0; i < 220; i++) {
  const p = PageSchema.parse(page());
  const file = serializePage(p);
  pages.push({ page: p, file, readBack: parsePage(file) });
}
const memories = [];
for (let i = 0; i < 220; i++) {
  const m = UserMemorySchema.parse(memory());
  const file = serializeUserMemory(m);
  memories.push({ memory: m, file, readBack: parseUserMemory(file) });
}

// Files as a person or an older build might have left them.
const head = "id: pg-abc12345\ntitle: T\nproject: null\nagentId: null\nrev: 1\ncreatedAt: 1\nupdatedAt: 2\nupdatedBy:\n  kind: user\n  agentId: null\n  name: null";
const RAW_PAGES = [
  `---\n${head}\n---\nbody\n`,
  `---\r\n${head.replaceAll("\n", "\r\n")}\r\n---\r\nbody\r\n`,
  `---\n${head}\n---`,
  `---\n${head}\n---\n`,
  `---\n${head}\nextra: kept out\nnested: { a: 1 }\n---\nbody`,
  `---\n${head}\nbody: from the frontmatter\n---\nthe real body`,
  `---\n${head.replace("title: T", "title: 123")}\n---\nbody`,
  `---\n${head.replace("title: T", 'title: "123"')}\n---\nbody`,
  `---\n${head.replace("title: T", "title: yes")}\n---\nbody`,
  `---\n${head.replace("title: T", "title: ~")}\n---\nbody`,
  `---\n${head.replace("title: T", "title: 2026-11-11")}\n---\nbody`,
  `---\n${head.replace("title: T", "title:")}\n---\nbody`,
  `---\n${head.replace("title: T", "title: >-\n  folded\n  title")}\n---\nbody`,
  `---\n${head.replace("rev: 1", "rev: -1")}\n---\nbody`,
  `---\n${head.replace("rev: 1", "rev: one")}\n---\nbody`,
  `---\n${head.replace("rev: 1", "rev: 1.5")}\n---\nbody`,
  `---\n${head.replace("project: null", "project: /Users/me/x y")}\n---\nbody`,
  `---\n${head.replace("project: null\n", "")}\n---\nbody`,
  `---\n${head.replace("id: pg-abc12345", "id: ../escape")}\n---\nbody`,
  `---\n${head.replace("id: pg-abc12345", "id: PG-ABC12345")}\n---\nbody`,
  `---\n${head.replace("kind: user", "kind: robot")}\n---\nbody`,
  `---\n${head.replace("createdAt: 1", "createdAt: 1.5e3")}\n---\nbody`,
  `---\n${head.replace("title: T", `title: ${"x".repeat(201)}`)}\n---\nbody`,
  `---\n${head}\n----\nbody after a longer fence`,
  `---\n${head}\n---\n---\nsecond fence is body\n---\n`,
  "no frontmatter", "", "---\n---\nbody", "---\n- a\n- b\n---\nbody", "---\njust a string\n---\nbody",
  "---\na: [unclosed\n---\nbody", `\ufeff---\n${head}\n---\nbody`, `---\n${head}\n`, `--- \n${head}\n---\nbody`,
  `---\n# a comment\n${head}\n---\nbody`, `---\n${head.split("\n").reverse().join("\n").replace("updatedBy:\n", "")}\n---\nbody`,
];
const rawPages = RAW_PAGES.map((raw) => {
  let out = null;
  try { out = parsePage(raw); } catch { out = null; }
  return { raw, page: out };
});

const mhead = "id: um-abc12345\ncategory: other\nscope:\n  kind: global\ntier: always\nstatus: active\nsource:\n  kind: user\nrev: 0\ncreatedAt: 1\nupdatedAt: 2";
const RAW_MEMORIES = [
  `---\n${mhead}\n---\nUse tabs.\n`,
  `---\n${mhead}\n---\n  padded text \n\n`,
  `---\n${mhead}\n---\n`,
  `---\n${mhead}\n---\n   \n`,
  `---\n${mhead}\ndomain: code\n---\nUse tabs.\n`,
  `---\n${mhead}\ndomain: cooking\n---\nUse tabs.\n`,
  `---\n${mhead}\ntext: in the frontmatter\n---\nThe real text.\n`,
  `---\n${mhead.replace("scope:\n  kind: global", "scope:\n  kind: project\n  path: /Users/me/x")}\n---\nUse tabs.\n`,
  `---\n${mhead.replace("scope:\n  kind: global", "scope:\n  kind: project")}\n---\nUse tabs.\n`,
  `---\n${mhead.replace("source:\n  kind: user", "source:\n  kind: agent\n  agentId: w-1\n  agentName: A")}\n---\nUse tabs.\n`,
  `---\n${mhead.replace("source:\n  kind: user", "source:\n  kind: agent\n  agentId: w-1")}\n---\nUse tabs.\n`,
  `---\n${mhead.replace("source:\n  kind: user", "source:\n  kind: dream\n  dreamId: dr-1\n  evidence: []")}\n---\nUse tabs.\n`,
  `---\n${mhead}\nproposal:\n  kind: merge\n  targets:\n    - um-aaaaaaaa\n    - um-bbbbbbbb\n---\nUse tabs.\n`,
  `---\n${mhead}\nproposal:\n  kind: merge\n  targets: [bad-id]\n---\nUse tabs.\n`,
  `---\n${mhead.replace("status: active", "status: kept")}\n---\nUse tabs.\n`,
  `---\n${mhead.replace("tier: always\n", "")}\n---\nUse tabs.\n`,
  `---\n${mhead}\n---\n${"x".repeat(501)}\n`,
  `---\n${mhead}\n---\n${"x".repeat(500)}\n`,
  "no frontmatter", "",
];
const rawMemories = RAW_MEMORIES.map((raw) => {
  let out = null;
  try { out = parseUserMemory(raw); } catch { out = null; }
  return { raw, memory: out };
});

// Profiles: what FileUserProfileStore writes and reads.
const serializeProfile = (p) => `${JSON.stringify(UserProfileSchema.parse(p), null, 2)}\n`;
const parseProfile = (raw) => {
  try {
    const r = UserProfileSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch { return null; }
};
const profiles = [];
let cur = emptyUserProfile();
profiles.push({ profile: cur, file: serializeProfile(cur) });
for (let i = 0; i < 60; i++) {
  cur = {
    ...applyProfilePatch(cur, {
      identity: { fullName: text().slice(0, 120), callName: text().slice(0, 60), handle: text().slice(0, 40) },
      language: { chat: pick([null, "tr", "mirror", "pt-BR"]), code: pick([null, "en"]) },
      work: { roles: chance(0.5) ? ["engineering", "design"] : [], stack: chance(0.5) ? ["Rust", "TypeScript", "C#"] : [], level: pick([null, "expert"]) },
      style: { replies: pick([null, "terse"]), autonomy: pick([null, "run"]), whenUnclear: pick([null, "ask"]), commits: pick([null, "on-request"]) },
      instructions: `${text()}\n${text()}`,
      sharing: { withholdFrom: chance(0.3) ? ["codex", "gemini"] : [] },
      budgetTokens: pick([200, 800, 4000]),
      onboardedAt: pick([null, 1791180846770]),
      dreaming: { enabled: chance(0.5), usageCeiling: pick([0.1, 0.7, 1, 0.35]), excludedProjects: chance(0.3) ? ["/a b", "/c"] : [] },
    }),
    identity: undefined,
  };
  cur = { ...cur, identity: { fullName: text().slice(0, 120).trim(), callName: "", handle: "", avatar: pick([null, "png", "jpeg", "webp"]) }, rev: i + 1, updatedAt: ts() };
  profiles.push({ profile: UserProfileSchema.parse(cur), file: serializeProfile(cur) });
}
const empty = JSON.stringify(emptyUserProfile());
const { dreaming: _dreaming, ...noDreaming } = emptyUserProfile();
const RAW_PROFILES = [
  empty, JSON.stringify(noDreaming), JSON.stringify({ ...emptyUserProfile(), extra: 1 }), "{}", "not json", "", "null", "[]",
  JSON.stringify({ ...emptyUserProfile(), budgetTokens: 100 }), JSON.stringify({ ...emptyUserProfile(), rev: -1 }),
  JSON.stringify({ ...emptyUserProfile(), language: { chat: "Turkish", code: null } }),
  JSON.stringify({ ...emptyUserProfile(), identity: { fullName: "A", callName: "", handle: "" } }),
  JSON.stringify({ ...emptyUserProfile(), updatedAt: 1.5 }),
];
const rawProfiles = RAW_PROFILES.map((raw) => ({ raw, profile: parseProfile(raw) }));

const out = { pages, rawPages, memories, rawMemories, profiles, rawProfiles };
writeFileSync(join(HERE, "../tests/fixtures/store-vectors.json"), `${JSON.stringify(out)}\n`);
console.log(Object.entries(out).map(([k, v]) => `${k}: ${v.length}`).join(", "));
