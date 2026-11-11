#!/usr/bin/env node
// Writes rust/fixtures/policy: what today's TypeScript decides, so the Rust
// port (crates/eos-policy) can be held to it.
//
//   node rust/tools/policy-vectors/generate.mjs            write the corpus
//   node rust/tools/policy-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 (runs the .ts sources directly) and `npm ci` in contracts/,
// core/ and infra/.
//
// decisions.json  every policy × tool × input × mode × tool scope, with the
//                 subagent / focused / plans-folder switches cycled through,
//                 decided by PolicyGatewayService.evaluate over a policy the
//                 real YAML loader read.
// units.json      the pieces on their own: tool patterns, tool categories,
//                 path containment, the mode a worker inherits, the summary of
//                 an ask, the rule-save document edit.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(REPO, "rust/fixtures/policy");
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { PolicyGatewayService } = await load("core/src/services/PolicyGatewayService.ts");
const { SqlBackedModeResolver } = await load("core/src/services/SqlBackedModeResolver.ts");
const { SqlBackedToolScopeResolver } = await load("core/src/services/SqlBackedToolScopeResolver.ts");
const { classifyTool, isPathInside } = await load("core/src/domain/permission-mode.ts");
const { matchesToolPattern } = await load("core/src/domain/tool-glob.ts");
const { loadPolicy } = await load("infra/src/policy/YamlPolicyLoader.ts");
const { summarizePendingInput } = await load("manager/services/permission-ask-push.ts");
const yaml = createRequire(path.join(REPO, "infra/package.json"))("yaml");

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const PLANS = "/home/u/.claude/plans";

// ---- policies ---------------------------------------------------------------

const shipped = readFileSync(path.join(REPO, "manager/policy.example.yaml"), "utf8");
const seeded = readFileSync(path.join(REPO, "rust/fixtures/wire/seed/home/policy.yaml"), "utf8");

// Each is the text of a policy.yaml. `doc` (what the yaml package parses it to)
// is recorded beside it, so the Rust loader can be fed either.
const POLICY_TEXTS = [
  "default: ask\nrules: []\n",
  "default: allow\n",
  "default: deny\nttlMs: 5000\n",
  shipped,
  seeded,
  // Tool lists, a rule for any tool, matchers on other fields.
  yaml.stringify({
    default: "ask",
    rules: [
      { tool: ["Read", "Glob", "Grep"], action: "allow" },
      { file_path: "\\.env(\\.|$)", action: "deny", reason: "secrets stay closed" },
      { tool: "WebFetch", url: "^https://(docs\\.)?example\\.com/", action: "allow" },
      { tool: "WebFetch", action: "deny" },
      { tool: ["Write", "Edit"], file_path: "^/repo/src/", action: "ask" },
      { tool: "mcp__github__create_issue", action: "deny", reason: "no issues from agents" },
    ],
  }),
  // Rewrites: another field, every replacement token, a named group.
  yaml.stringify({
    default: "deny",
    rules: [
      { tool: "Bash", command: "^git push", action: "rewrite", rewriteFrom: "^git push\\b(.*)$", rewriteTo: "git push --dry-run$1 # was: $&" },
      { tool: "Bash", command: "^(?<cmd>npm) ", action: "rewrite", rewriteFrom: "^(?<cmd>\\w+) (?<rest>.*)$", rewriteTo: "$<cmd> --silent $<rest> $$ $` $' $0 $1 $9" },
      { tool: "WebFetch", action: "rewrite", rewriteField: "url", rewriteFrom: "^http:", rewriteTo: "https:" },
      { tool: "Write", action: "rewrite", rewriteField: "missing", rewriteFrom: "^", rewriteTo: "added" },
      { tool: "Bash", action: "allow" },
    ],
  }),
  // Things the loader drops or reads loosely.
  yaml.stringify({
    default: "sometimes",
    ttlMs: "soon",
    rules: [
      { tool: "Bash", command: "([invalid", action: "deny" },
      { tool: "Bash", action: "rewrite" },
      { tool: "Bash", action: "rewrite", rewriteFrom: "([bad", rewriteTo: "x" },
      { tool: "Bash", action: "rewrite", rewriteFrom: "", rewriteTo: "x" },
      { tool: "Read", action: "permit" },
      { tool: "Read", file_path: "secret", action: "deny" },
      { tool: "Edit" },
      { tool: "", action: "deny", command: "^forbidden$" },
      { tool: [], action: "deny" },
      { tool: 5, action: "deny" },
      { tool: ["Write", 7, null], action: "deny", reason: 404 },
      { tool: "Glob", action: "deny", reason: null },
      { tool: "Bash", command: 42, action: "deny", reason: "the answer" },
      { tool: "Bash", command: true, action: "ask" },
      { tool: "Grep", pattern: null, action: "allow" },
      { tool: "LS", path: ["a", "b"], action: "deny" },
    ],
  }),
  yaml.stringify({ default: "rewrite", rules: [{ tool: "Bash", action: "ask" }] }),
  // Not a mapping at all, and rules that is not a list.
  "- just\n- a list\n",
  "default: allow\nrules: none\n",
  "",
  "default: [unclosed\n",
  // Lookbehind, unicode, flow style with comments.
  "default: ask # trailing comment\nrules:\n  - { tool: Bash, command: \"(?<![\\\\w-])sudo\\\\b\", action: deny, reason: \"no sudo\" }\n  - { tool: Bash, command: \"é|😀\", action: allow }\n  - { tool: Bash, command: \"^.{3}$\", action: deny, reason: \"three units\" }\n",
];

const dir = mkdtempSync(path.join(tmpdir(), "eos-policy-vectors-"));
const policies = POLICY_TEXTS.map((text, i) => {
  const file = path.join(dir, `policy-${i}.yaml`);
  writeFileSync(file, text);
  const policy = loadPolicy({ candidates: [file], defaultTtlMs: 0, log: quiet });
  let doc;
  let parses = true;
  try { doc = yaml.parse(text); } catch { parses = false; }
  return {
    text,
    parses,
    doc: parses ? (doc ?? null) : null,
    loaded: { default: policy.default, ttlMs: policy.ttlMs, rules: policy.rules.length },
    policy,
  };
});
rmSync(dir, { recursive: true, force: true });

// ---- the matrix -------------------------------------------------------------

const SHELL_INPUTS = [
  {},
  { command: "rm -rf build" },
  { command: "curl https://example.com" },
  { command: "curl --max-time 5 https://example.com", description: "fetch" },
  { command: "git push origin main" },
  { command: "  git push  " },
  { command: "git pushx" },
  { command: "npm run build" },
  { command: "sudo ls" },
  { command: "forbidden" },
  { command: 42 },
  { command: true },
  { command: ["a", "b"] },
  { command: null },
  { command: "é" },
  { command: "😀!" },
  { command: "rm -rf ~/.eos/scratch/abc/build" },
  { command: "rm -rf ~/.eos" },
];
const FILE_INPUTS = [
  {},
  { file_path: "/repo/src/a.ts", content: "x" },
  { file_path: "/repo/.env.local" },
  { file_path: "/repo/docs/secret.md" },
  { file_path: `${PLANS}/plan.md` },
  { file_path: `${PLANS}/../../.ssh/config` },
  { notebook_path: "/repo/src/n.ipynb" },
  { file_path: null, notebook_path: "/repo/src/n.ipynb" },
  { file_path: 5 },
  { file_path: "relative/a.ts" },
];
const OTHER_INPUTS = [
  {},
  { url: "http://docs.example.com/a" },
  { url: "https://example.com/b", prompt: "read" },
  { pattern: "TODO", path: "/repo" },
  { path: ["a", "b"] },
  { title: "x", command: "ls", file_path: "/repo/src/a.ts" },
];
const TOOLS = [
  ["Bash", SHELL_INPUTS], ["BashOutput", SHELL_INPUTS.slice(0, 3)], ["KillShell", [{}]], ["KillBash", [{}]],
  ["Write", FILE_INPUTS], ["Edit", FILE_INPUTS], ["MultiEdit", FILE_INPUTS.slice(0, 5)], ["NotebookEdit", FILE_INPUTS],
  ["Read", FILE_INPUTS.slice(0, 5)], ["Glob", OTHER_INPUTS.slice(0, 4)], ["Grep", OTHER_INPUTS.slice(0, 4)], ["LS", OTHER_INPUTS],
  ["WebFetch", OTHER_INPUTS.slice(0, 3)], ["WebSearch", [{}, { query: "x" }]],
  ["TodoWrite", [{}]], ["Task", [{}, { prompt: "go" }]], ["Agent", [{}]], ["ExitPlanMode", [{}]], ["Skill", [{}]],
  ["AskUserQuestion", [{ questions: [] }]], ["Workflow", [{}]],
  ["mcp__github__create_issue", [{ title: "x" }]], ["mcp__context7__query-docs", [{}]],
  ["mcp__worker__send_message_to_parent", [{ text: "done" }]], ["mcp__worker__ask_peer", [{}]],
  ["mcp__orchestrator__spawn_worker", [{ from: "explorer" }]], ["mcp__gateway__decide", [{}]],
  ["mcp__worker__browser_snapshot", [{}]], ["mcp__worker__browser_click", [{ ref: "e1" }]],
  ["mcp__orchestrator__browser_navigate", [{ url: "https://x" }]], ["mcp__orchestrator__browser_tabs", [{}]],
  ["mcp__worker__present", [{ title: "t" }]], ["mcp__orchestrator__present_app", [{}]],
  ["SomethingElse", OTHER_INPUTS.slice(0, 2)], ["", [{}]],
];
const MODES = ["acceptEdits", "bypassPermissions"];
const SCOPES = [
  null,
  { allow: [], deny: [], editRegex: null },
  { allow: ["Read", "Grep", "Glob"], deny: [], editRegex: null },
  { allow: [], deny: ["Bash"], editRegex: null },
  { allow: [], deny: ["mcp__*"], editRegex: null },
  { allow: [], deny: ["Bash(git push:*)", "Bash(rm *)"], editRegex: null },
  { allow: ["Bash(git *)", "Bash(ls)", "Read", "Edit", "Write", "NotebookEdit"], deny: [], editRegex: "^/repo/src/" },
  { allow: [], deny: [], editRegex: "([" },
  { allow: [], deny: [], editRegex: "\\.ipynb$" },
  { allow: [], deny: ["mcp__worker__browser_*", "mcp__orchestrator__browser_n*"], editRegex: null },
  { allow: ["*"], deny: ["*Edit", "Web*"], editRegex: null },
  { allow: ["Read"], deny: ["mcp__worker__*", "mcp__orchestrator__*", "mcp__gateway__*", "mcp__*"], editRegex: null },
  { allow: ["Bash(*)", "mcp__*__create_*"], deny: ["Bash()"], editRegex: "" },
];
// agentId, fullSurface, plansDir — cycled so every combination meets every
// tool, without multiplying the corpus by eight.
const SWITCHES = [];
for (const agentId of [null, "agent-1"]) for (const fullSurface of [false, true]) for (const plansDir of [null, PLANS]) SWITCHES.push({ agentId, fullSurface, plansDir });

function decider(mode, scope, plansDir) {
  return new PolicyGatewayService({
    pending: {}, events: {}, clock: {}, ids: {},
    bus: { publish() {}, subscribe: () => () => {} },
    modeResolver: { resolveFor: () => mode },
    toolScopeResolver: { resolveFor: () => scope },
    ...(plansDir ? { plansDir } : {}),
    getPolicy: () => { throw new Error("unused"); },
  });
}

const decisions = [];
const decisionIndex = new Map();
const inputs = [];
const inputIndex = new Map();
const intern = (table, index, value) => {
  const key = JSON.stringify(value);
  let at = index.get(key);
  if (at === undefined) { at = table.length; table.push(value); index.set(key, at); }
  return at;
};

const cases = [];
let n = 0;
for (let p = 0; p < policies.length; p++) {
  for (let t = 0; t < TOOLS.length; t++) {
    const [tool, toolInputs] = TOOLS[t];
    for (const input of toolInputs) {
      const i = intern(inputs, inputIndex, input);
      for (let m = 0; m < MODES.length; m++) {
        for (let s = 0; s < SCOPES.length; s++) {
          // Every switch combination for the first policies' scope-free cases; one, cycled, for the rest.
          const which = s === 0 && p < 6 ? SWITCHES.map((_, w) => w) : [n++ % SWITCHES.length];
          for (const w of which) {
            const sw = SWITCHES[w];
            const svc = decider(MODES[m], SCOPES[s], sw.plansDir);
            const decision = svc.evaluate(policies[p].policy, "w1", tool, structuredClone(input), sw.agentId, sw.fullSurface);
            cases.push([p, t, i, m, s, w, intern(decisions, decisionIndex, decision)]);
          }
        }
      }
    }
  }
}

// ---- units ------------------------------------------------------------------

const PATTERNS = ["*", "Bash", "Bash*", "mcp__*", "mcp__*__create_*", "*Edit", "Bash(git push:*)", "Bash(git *)", "Bash(ls)", "Bash(*)", "Bash()", "Bash(a(b):*)", "Ba*(x)", "(x)", "Bash(", "Bash(x)y", "a.b", "a?b", "Bash(:*)", "Bash(*:*)", "B\nash*", "Bash(npm run *:*)"];
const NAMES = ["Bash", "BashOutput", "Read", "Edit", "MultiEdit", "mcp__github__create_issue", "mcp__worker__report", "a.b", "axb", "", "Ba", "B\nashX", "(x)", "Bash(", "Bash(x)y"];
const ARGS = [null, "", "git push", "git push origin", "  git push  ", "git pushx", "git status", "ls", "ls -la", "x", "a(b) c", "npm run build", "npm run", "\ufeffls\u00a0", "\u0085ls", "multi\nline", ":*"];
const globs = [];
for (const pattern of PATTERNS) for (const name of NAMES) for (const arg of ARGS) {
  if (matchesToolPattern(name, pattern, arg ?? undefined)) globs.push([pattern, name, arg]);
}

const classify = [];
for (const [tool, toolInputs] of TOOLS) for (const input of toolInputs) for (const plansDir of [null, PLANS, ""]) {
  classify.push({ tool, input, plansDir, category: classifyTool(tool, input, plansDir ?? undefined) });
}
for (const tool of ["mcp__worker__browser_", "mcp__worker__browser_find", "mcp__orchestrator__browser_get", "mcp__worker__browser_screenshot", "mcp__worker__browser_show", "mcp__worker__browser_type", "mcp__worker__browser_snapshot_x", "mcp__x__browser_snapshot", "browser_snapshot"]) {
  classify.push({ tool, input: {}, plansDir: null, category: classifyTool(tool, {}, undefined) });
}

const PATHS = ["/a/b", "/a/b/", "/a/b/c", "/a/bc", "/a/./b//c", "/a/b/../c", "/a/b/c/..", "/../../a/x", "a/b/c", "", "/", "/a", "C:\\Users\\Me\\plans\\x.md", "c:/users/me/plans", "C:/Users/Me/plans/../x", "D:\\Users\\Me\\plans\\x.md", "C:plans", "/İ/x", "C:\\İ\\x", "c:/i̇"];
const inside = [];
for (const child of PATHS) for (const parent of PATHS) if (isPathInside(child, parent)) inside.push([child, parent]);

// A worker tree: who inherits which mode, and which stored scope counts.
const ROWS = [
  { id: "root-bypass", parent_id: null, permission_mode: "bypassPermissions", tool_scope: null },
  { id: "root-accept", parent_id: null, permission_mode: "acceptEdits", tool_scope: null },
  { id: "root-unset", parent_id: null, permission_mode: null, tool_scope: null },
  { id: "root-legacy", parent_id: null, permission_mode: "plan", tool_scope: null },
  { id: "kid-inherits", parent_id: "root-accept", permission_mode: null, tool_scope: '{"allow":["Read"],"deny":[],"editRegex":null}' },
  { id: "kid-own", parent_id: "root-accept", permission_mode: "bypassPermissions", tool_scope: '{"deny":["Bash"]}' },
  { id: "grandkid", parent_id: "kid-inherits", permission_mode: "default", tool_scope: '{"allow":[],"deny":[],"editRegex":"^/x"}' },
  { id: "kid-legacy", parent_id: "root-legacy", permission_mode: "", tool_scope: "" },
  { id: "orphan", parent_id: "gone", permission_mode: null, tool_scope: "not json" },
  { id: "loop-a", parent_id: "loop-b", permission_mode: null, tool_scope: '["Read"]' },
  { id: "loop-b", parent_id: "loop-a", permission_mode: null, tool_scope: '{"allow":"Read"}' },
  { id: "empty-parent", parent_id: "", permission_mode: "weird", tool_scope: '{"allow":["A"],"deny":["B"],"editRegex":5}' },
  { id: "extra-keys", parent_id: "root-bypass", permission_mode: null, tool_scope: '{"allow":["A"],"extra":1}' },
  { id: "null-scope", parent_id: "root-unset", permission_mode: null, tool_scope: "null" },
];
const repo = { findById: (id) => ROWS.find((r) => r.id === id) ?? null };
const modes = new SqlBackedModeResolver(repo);
const scopes = new SqlBackedToolScopeResolver(repo);
const chain = [...ROWS.map((r) => r.id), "unknown"].map((id) => ({ id, mode: modes.resolveFor(id), scope: scopes.resolveFor(id) }));

const SUMMARIES = [
  '{"command":"  npm   run\\n build ","file_path":"/x"}', '{"command":"  ","file_path":"/a/b.md"}', '{"command":5,"file_path":" "}',
  '{"url":"https://x"}', "not json", "[1,2]", '"text"', "null", "", `{"command":"${"a".repeat(400)}"}`,
  `{"command":"${"😀".repeat(100)}"}`, `{"file_path":"${"é".repeat(159)}xyz"}`, '{"command":"a\\u00a0\\u2028b\\ufeff c"}', "  spaced\tout  ",
];
// A cut can split a surrogate pair; Rust strings cannot hold the half, so it
// is compared as U+FFFD on both sides.
const summaries = SUMMARIES.map((input) => ({ input, summary: summarizePendingInput(input).toWellFormed() }));

const out = {
  decisions: {
    about: "PolicyGatewayService.evaluate over policies read by the real YAML loader. case = [policy, tool, input, mode, scope, switch, decision], each an index into the list of that name.",
    policies: policies.map(({ text, parses, doc, loaded }) => ({ text, parses, doc, loaded })),
    tools: TOOLS.map(([tool]) => tool),
    inputs,
    modes: MODES,
    scopes: SCOPES,
    switches: SWITCHES,
    decisions,
    cases,
  },
  units: {
    about: "globs: every [pattern, name, argument] of patterns × names × args that matches (all others do not). inside: every [child, parent] of paths × paths where child is inside parent.",
    patterns: PATTERNS, names: NAMES, args: ARGS, globs,
    classify,
    paths: PATHS, inside,
    rows: ROWS, chain,
    summaries,
  },
};

const files = {
  "decisions.json": JSON.stringify(out.decisions) + "\n",
  "units.json": JSON.stringify(out.units, null, 1) + "\n",
};
if (process.argv.includes("--check")) {
  let stale = false;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(OUT, name);
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) { console.error(`${name} would change`); stale = true; }
  }
  process.exit(stale ? 1 : 0);
}
mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(path.join(OUT, name), text);
console.log(`${cases.length} decisions (${decisions.length} distinct), ${policies.length} policies, ${globs.length} glob matches, ${classify.length} classifications`);
