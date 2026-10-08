// Dev utility: replays your past decisions on dream proposals — kept vs dismissed,
// read from ~/.eos/profile/memories (.trash included) — through today's writing
// rules and critic, and reports how many dismissed ones they'd turn down and how
// many kept ones still pass. A kept memory counts by its gist: it is judged as it
// reads today, so a rewrite after keeping doesn't count against the critic.
// Uses the Eos Claude sign-in and one critic call per three proposals. No daemon,
// no writes.
//
// Usage: bash scripts/dream-eval.sh [--model opus|sonnet|haiku] [--limit N]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { FilePromptSource } from "../infra/src/prompt/FilePromptSource.ts";
import { parseUserMemory } from "../infra/src/persistence/FileUserMemoryStore.ts";
import { createSubscriptionAuthResolver, readClaudeCodeLogin } from "../infra/src/auth/SubscriptionAuthResolver.ts";
import { PromptRegistry } from "../core/src/services/PromptRegistry.ts";
import { PromptService } from "../core/src/services/PromptService.ts";
import { renderUserProfile } from "../core/src/services/render-user-profile.ts";
import { applyVerdicts, lintMemoryText, parseCritic, type CheckedProposal } from "../core/src/domain/dream.ts";
import { dayKey, foldText, isCandidateReady } from "../core/src/domain/dream-ledger.ts";
import { formatMemories, formatProposals } from "../core/src/domain/dream-prompt-data.ts";
import { createSdkSummarizer } from "../manager/backends/sdk/SdkSummarizer.ts";
import { DREAM_SCHEMAS } from "../manager/services/dream-schemas.ts";
import { TOOL_NAME_VARS } from "../manager/prompt-tool-names.ts";
import { UserProfileSchema, type UserMemory } from "../contracts/src/profile.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = join(homedir(), ".eos");
const MEMORIES = join(HOME, "profile", "memories");
const BATCH = 3;
// What recall would copy as the user's own generalising words.
const MARKER = /\b(bundan sonra|her zaman|hep|asla|hicbir zaman|her seferinde|always|never|from now on|every time)\b/;
// Proposals filed by the same dream sit within this of each other.
const SAME_NIGHT_MS = 60_000;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

type Outcome = "kept" | "declined";

function load(dir: string): UserMemory[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).flatMap((f) => {
    const m = parseUserMemory(readFileSync(join(dir, f), "utf8"));
    return m ? [m] : [];
  });
}

// Kept = still active, or deleted after keeping. An applied change proposal repeats
// the memory it changed, so it isn't counted again.
function outcome(m: UserMemory): Outcome | null {
  if (m.status === "dismissed") return "declined";
  return m.status === "active" ? "kept" : null;
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } };
const prompts = new PromptService(new PromptRegistry(new FilePromptSource([join(REPO, "manager", "prompts")]), noopLogger), TOOL_NAME_VARS);
const profile = UserProfileSchema.parse(JSON.parse(readFileSync(join(HOME, "profile", "profile.json"), "utf8")));
const model = arg("--model") ?? profile.dreaming.model;
const claudeStore = join(HOME, "accounts", "claude");
const summarizer = createSdkSummarizer({
  authResolver: createSubscriptionAuthResolver({ readLogin: () => readClaudeCodeLogin(claudeStore) }),
  daemonUrl: "http://127.0.0.1:0", claudeStore, defaultModel: model, cwd: REPO,
});
const db = existsSync(join(HOME, "state.db")) ? new DatabaseSync(join(HOME, "state.db"), { readOnly: true }) : null;
const tsOf = (eventId: number | null): number | null =>
  db && eventId !== null ? ((db.prepare("SELECT ts FROM events WHERE id = ?").get(eventId) as { ts: number } | undefined)?.ts ?? null) : null;

const all = [...load(MEMORIES), ...load(join(MEMORIES, ".trash"))];
const cases = all.flatMap((m) => {
  const o = outcome(m);
  return o && m.source.kind === "dream" && m.source.evidence.length ? [{ m, outcome: o }] : [];
}).sort((a, b) => a.m.createdAt - b.m.createdAt).slice(0, Number(arg("--limit") ?? Infinity));

// A proposal as the critic would see it tonight, rebuilt from what the memory kept.
function asProposal(m: UserMemory): CheckedProposal {
  const evidence = m.source.kind === "dream" ? m.source.evidence : [];
  const support = evidence.map((e) => {
    const at = tsOf(e.eventId) ?? m.createdAt;
    return {
      workerId: e.workerId, chat: e.chat, project: m.scope.kind === "project" ? m.scope.path : null, day: dayKey(at), at,
      stance: "process-correction" as const, marker: MARKER.exec(foldText(e.quote))?.[0] ?? null, reason: null, irreversible: false, evidence: [e],
    };
  });
  const candidate = {
    id: `eval-${m.id}`, claim: m.text, object: "agent-behaviour" as const, target: null, support,
    firstSeen: Math.min(...support.map((s) => s.at)), lastSeen: Math.max(...support.map((s) => s.at)),
  };
  const why = m.source.kind === "dream" && m.source.why ? m.source.why : "(not recorded)";
  return {
    draft: { candidate: candidate.id, kind: "new", text: m.text, category: m.category === "other" ? "work-style" : m.category, domain: m.domain ?? "planning", targets: [], why },
    candidate, scope: m.scope, targets: [],
  };
}

const rows: { outcome: Outcome; ready: boolean; lint: string | null; critic: string | null; text: string }[] = [];
for (let i = 0; i < cases.length; i += BATCH) {
  const batch = cases.slice(i, i + BATCH);
  // Only what existed before that dream, minus the proposals under test and what they changed.
  const before = Math.min(...batch.map(({ m }) => m.createdAt)) - SAME_NIGHT_MS;
  const hidden = new Set(batch.flatMap(({ m }) => [m.id, ...(m.proposal?.targets ?? [])]));
  const context = all.filter((m) => m.createdAt < before && !hidden.has(m.id));
  const proposals = batch.map(({ m }) => asProposal(m));
  process.stderr.write(`critic ${i / BATCH + 1}/${Math.ceil(cases.length / BATCH)}…\n`);
  const verdicts = parseCritic(await summarizer.summarizeStructured({
    system: prompts.render("dream/critic-system"),
    prompt: prompts.render("dream/critic", {
      PROPOSALS: formatProposals(proposals), MEMORIES: formatMemories(context),
      PROFILE: renderUserProfile(profile, context, { project: null }).text,
    }),
    model, timeoutMs: 180_000, schema: DREAM_SCHEMAS.critic,
  })) ?? [];
  const { rejected } = applyVerdicts(proposals, verdicts);
  for (const [j, { m, outcome: o }] of batch.entries()) {
    const refuted = rejected.find((r) => r.text === proposals[j]!.draft.text);
    rows.push({ outcome: o, ready: isCandidateReady(proposals[j]!.candidate), lint: lintMemoryText(m.text), critic: refuted?.reason ?? null, text: m.text });
  }
}

const share = (o: Outcome, test: (r: (typeof rows)[number]) => boolean): string => {
  const set = rows.filter((r) => r.outcome === o);
  return `${set.filter(test).length}/${set.length}`;
};
for (const r of rows) {
  console.log(`${r.outcome.padEnd(8)} ${r.ready ? "ready" : "waits"}  ${r.critic ? "critic ✗" : "critic ✓"}  ${r.lint ? "lint ✗" : "lint ✓"}  ${r.text.slice(0, 80)}`);
  if (r.critic) console.log(`         ↳ ${r.critic}`);
}
console.log(`
model ${model} · ${rows.length} decisions
dismissed turned down by the critic        ${share("declined", (r) => r.critic !== null)}
dismissed failing the writing rules        ${share("declined", (r) => r.lint !== null)}
dismissed still waiting in the ledger      ${share("declined", (r) => !r.ready)}
kept passing the critic                    ${share("kept", (r) => r.critic === null)}
kept ready by the ledger's count           ${share("kept", (r) => r.ready)}
(a kept memory is judged by today's text; one still in the old style fails test 4)`);
