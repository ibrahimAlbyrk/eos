import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dreamOverChats, type DreamDeps } from "../use-cases/DreamOverChats.ts";
import { DREAM_PENDING_CAP, UserMemoryService } from "../services/UserMemoryService.ts";
import { emptyUserProfile } from "../domain/user-profile.ts";
import type { DreamRepo } from "../ports/DreamRepo.ts";
import type { DreamLine, DreamSession } from "../domain/dream.ts";
import type { DreamCandidate, DreamRun } from "../../../contracts/src/dream.ts";
import type { UserMemory, UserProfile } from "../../../contracts/src/profile.ts";

const DAY = 24 * 60 * 60_000;
const T0 = new Date(2026, 9, 5, 12).getTime();

function memRepo(): DreamRepo & { marks: Map<string, number>; ledger: () => DreamCandidate[] } {
  const runs = new Map<string, DreamRun>();
  const marks = new Map<string, number>();
  const excluded = new Set<string>();
  let ledger: DreamCandidate[] = [];
  return {
    marks,
    ledger: () => ledger,
    save: (r) => { runs.set(r.id, r); },
    get: (id) => runs.get(id) ?? null,
    list: () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt),
    latest: () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null,
    watermark: (id) => marks.get(id) ?? 0,
    setWatermark: (id, e) => { marks.set(id, e); },
    excluded: () => [...excluded],
    setExcluded: (id, on) => { if (on) excluded.add(id); else excluded.delete(id); },
    candidates: () => [...ledger],
    replaceCandidates: (c) => { ledger = [...c]; },
  };
}

const signal = (ask: string, evidence: number[], over: Record<string, unknown> = {}) =>
  ({ ask, object: "agent-behaviour", stance: "process-correction", evidence, ...over });

const PROPOSAL = {
  candidate: "", kind: "new", text: "When a task is a large feature, present a plan and wait for approval.",
  category: "work-style", domain: "planning", why: "Agents start coding before the user agrees on the approach.",
};

interface Replies {
  recall?: (prompt: string) => unknown;
  match?: (prompt: string) => unknown;
  consolidate?: (prompt: string) => unknown;
  critic?: (prompt: string) => unknown;
}

function setup(opts: { replies?: Replies; stopAfter?: number; profile?: Partial<UserProfile>; sessions?: DreamSession[]; lines?: Record<string, DreamLine[]> } = {}) {
  const repo = memRepo();
  const store = new Map<string, UserMemory>();
  let n = 0;
  let now = T0 + 2 * DAY;
  const memories = new UserMemoryService({
    store: { list: () => [...store.values()], get: (id) => store.get(id) ?? null, put: (m) => { store.set(m.id, m); }, remove: (id) => store.delete(id) },
    clock: { now: () => (now += 1) },
    bus: { publish: () => {} },
    newId: () => `um-dream${String(++n).padStart(4, "0")}`,
  });
  const profile = { ...emptyUserProfile(), ...opts.profile };
  const steps: string[] = [];
  const prompts: string[] = [];
  let calls = 0;
  let runs = 0;
  const sessions = opts.sessions ?? [
    { workerId: "w-1", name: "profile-design", project: "/eos", noFolder: false, working: false, lastEventId: 30 },
    { workerId: "w-2", name: "stance-ik", project: "/dear-souls", noFolder: false, working: false, lastEventId: 20 },
    { workerId: "w-3", name: "busy", project: "/eos", noFolder: false, working: true, lastEventId: 99 },
  ];
  const lines = opts.lines ?? {
    "w-1": [{ id: 11, role: "user", text: "bundan sonra büyük işlerde önce plan çıkar", at: T0 }, { id: 12, role: "assistant", text: "Sure.", at: T0 }],
    "w-2": [{ id: 21, role: "user", text: "3 run başlat, tema sonbahar olsun", at: T0 }],
  };
  // The candidate id the match step creates, read back from the ledger for later steps.
  const firstCandidate = (): string => repo.ledger()[0]?.id ?? "dc-none";
  const r = opts.replies ?? {};
  const deps: DreamDeps = {
    repo,
    summarizer: {
      summarizeStructured: async ({ prompt }) => {
        calls++;
        prompts.push(prompt);
        const step = prompt.split(" ")[0]!.replace("dream/", "");
        steps.push(step);
        if (step === "recall") {
          if (r.recall) return r.recall(prompt);
          return prompt.includes("profile-design")
            ? { signals: [signal("Wants a plan before large features.", [11], { stance: "general-rule", marker: "bundan sonra" })] }
            : { signals: [signal("Start 3 runs with the autumn theme.", [21], { stance: "task-instruction" })] };
        }
        if (step === "match") return r.match ? r.match(prompt) : { groups: [{ signals: [0], claim: "Wants a plan before large features." }] };
        if (step === "consolidate") {
          return r.consolidate ? r.consolidate(prompt) : { narrative: "You asked for plans first.", proposals: [{ ...PROPOSAL, candidate: firstCandidate() }] };
        }
        return r.critic ? r.critic(prompt) : { verdicts: [{ proposal: 0, keep: true, quotes: [{ eventId: 11, says: "yes" }], reason: "Stated as a rule." }] };
      },
    },
    schemas: { recall: { title: "recall" }, match: { title: "match" }, consolidate: { title: "consolidate" }, critic: { title: "critic" } },
    prompts: { render: (id, vars) => `${id} ${JSON.stringify(vars ?? {})}` },
    sessions: () => sessions,
    lines: (id, after) => (lines[id] ?? []).filter((l) => l.id > after),
    memories,
    profile: { get: () => profile },
    profileDigest: () => "`<user_profile>` …",
    clock: { now: () => (now += 10) },
    newId: () => `dr-test${++runs}`,
    timeoutMs: 1000,
    shouldStop: () => opts.stopAfter !== undefined && calls >= opts.stopAfter,
  };
  return { deps, repo, memories, steps, prompts };
}

describe("dreamOverChats", () => {
  it("a stated rule goes recall → match → consolidate → critic → filed; a task step is dropped by code", async () => {
    const { deps, repo, memories, steps } = setup();
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.deepEqual(steps, ["recall", "recall", "match", "consolidate", "critic"]);
    assert.equal(run.status, "done");
    assert.equal(run.chatsRead, 2); // the working chat is skipped
    assert.equal(run.observations, 2);
    assert.equal(run.dropped.taskBound, 1);
    assert.equal(run.proposed, 1);
    assert.equal(run.narrative, "You asked for plans first.");
    const filed = memories.list()[0]!;
    assert.equal(filed.status, "suggested");
    assert.equal(filed.domain, "planning");
    assert.deepEqual(filed.scope, { kind: "project", path: "/eos" });
    assert.equal(filed.proposal?.support?.origin, "explicit");
    assert.equal(filed.source.kind === "dream" && filed.source.why, PROPOSAL.why);
    assert.deepEqual(filed.source.kind === "dream" && filed.source.evidence[0], {
      quote: "bundan sonra büyük işlerde önce plan çıkar", workerId: "w-1", chat: "profile-design", eventId: 11, by: "user",
    });
    assert.deepEqual([repo.watermark("w-1"), repo.watermark("w-2"), repo.watermark("w-3")], [30, 20, 0]);
    assert.equal(repo.ledger().length, 0); // proposed → settled
    assert.equal(run.candidates, 0);
  });

  it("an inferred wish waits in the ledger until a second chat on another day backs it", async () => {
    const inferred: Replies = { recall: (p) => (p.includes("profile-design") ? { signals: [signal("Wants a plan first.", [11])] } : { signals: [] }) };
    const { deps, repo, steps } = setup({ replies: inferred });
    const first = await dreamOverChats(deps, { trigger: "nightly" });
    assert.deepEqual(steps, ["recall", "recall", "match"]);
    assert.equal(first.proposed, 0);
    assert.match(first.reason ?? "", /1 idea is still gathering support/);
    assert.equal(first.candidates, 1);
    assert.equal(repo.watermark("w-1"), 30); // the ledger holds tonight's signals

    const second = setup({
      replies: {
        recall: () => ({ signals: [signal("Wants a plan first.", [41])] }),
        match: () => ({ groups: [{ signals: [0], candidate: repo.ledger()[0]!.id }] }),
        consolidate: () => ({ narrative: "", proposals: [{ ...PROPOSAL, candidate: repo.ledger()[0]!.id }] }),
        critic: () => ({ verdicts: [{ proposal: 0, keep: true, quotes: [{ eventId: 41, says: "yes" }] }] }),
      },
      sessions: [{ workerId: "w-4", name: "other", project: "/game", noFolder: false, working: false, lastEventId: 41 }],
      lines: { "w-4": [{ id: 41, role: "user", text: "önce plan çıkar", at: T0 + DAY }] },
    });
    second.deps = { ...second.deps, repo: Object.assign(second.repo, { candidates: repo.candidates, replaceCandidates: repo.replaceCandidates }) };
    const run = await dreamOverChats(second.deps, { trigger: "nightly" });
    assert.equal(run.proposed, 1);
    assert.deepEqual(second.memories.list()[0]!.scope, { kind: "global" }); // seen in two projects
  });

  it("the critic refutes → nothing filed, the reason is logged, the candidate leaves the ledger", async () => {
    const { deps, repo, memories } = setup({
      replies: { critic: () => ({ verdicts: [{ proposal: 0, keep: false, fails: [2], quotes: [{ eventId: 11, says: "topical" }], reason: "A step of one task." }] }) },
    });
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.proposed, 0);
    assert.equal(run.dropped.critic, 1);
    assert.equal(run.rejected[0]!.reason, "A step of one task. (one task's step)");
    assert.equal(run.reason, "Nothing passed review this time");
    assert.equal(memories.list().length, 0);
    assert.equal(repo.ledger().length, 0);
  });

  it("a badly written proposal, or one with no ready candidate behind it, never reaches the critic", async () => {
    let ledger: () => DreamCandidate[] = () => [];
    const bad = setup({
      replies: { consolidate: () => ({ narrative: "", proposals: [{ ...PROPOSAL, text: "Usually wants plans.", candidate: ledger()[0]!.id }] }) },
    });
    ledger = bad.repo.ledger;
    const run = await dreamOverChats(bad.deps, { trigger: "nightly" });
    assert.ok(!bad.steps.includes("critic"));
    assert.equal(run.dropped.style, 1);
    assert.match(run.rejected[0]!.reason, /^Writing: doesn't open with its situation/);

    const orphan = setup({ replies: { consolidate: () => ({ narrative: "", proposals: [{ ...PROPOSAL, candidate: "dc-nope" }] }) } });
    const r2 = await dreamOverChats(orphan.deps, { trigger: "nightly" });
    assert.equal(r2.dropped.invalid, 1);
    assert.equal(orphan.repo.ledger().length, 1); // not settled — still ready next time
  });

  it("nothing new since the last dream → skipped, no model call", async () => {
    const { deps, repo, steps } = setup();
    repo.setWatermark("w-1", 30);
    repo.setWatermark("w-2", 20);
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.status, "skipped");
    assert.equal(steps.length, 0);
  });

  it("excluded projects and chats are never read", async () => {
    const { deps, repo, steps } = setup({ profile: { dreaming: { ...emptyUserProfile().dreaming, excludedProjects: ["/dear-souls"] } } });
    repo.setExcluded("w-1", true);
    const run = await dreamOverChats(deps, { trigger: "manual" });
    assert.equal(run.status, "skipped");
    assert.equal(steps.length, 0);
  });

  it("stopping keeps what was read; unread chats keep their watermark", async () => {
    const { deps, repo } = setup({ stopAfter: 1 });
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.status, "stopped");
    assert.equal(run.chatsRead, 1);
    assert.deepEqual([repo.watermark("w-1"), repo.watermark("w-2")], [30, 0]);
  });

  it("a match off its schema fails without touching the ledger or the watermarks", async () => {
    const { deps, repo, memories } = setup({ replies: { match: () => ({ groups: "nope" }) } });
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.status, "failed");
    assert.equal(memories.list().length, 0);
    assert.equal(repo.ledger().length, 0);
    assert.equal(repo.watermark("w-1"), 0);
  });

  it("a failed consolidation keeps the ready candidate for the next dream", async () => {
    const { deps, repo } = setup({ replies: { consolidate: () => ({ proposals: "nope" }) } });
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.status, "failed");
    assert.equal(repo.ledger().length, 1);
    assert.equal(repo.watermark("w-1"), 30);
  });

  it("a declined idea counts as declined; a full review counts as capped and waits", async () => {
    const { deps, memories, repo } = setup();
    const old = memories.suggest({ text: PROPOSAL.text, category: "work-style", scope: { kind: "project", path: "/eos" } }, { kind: "agent", agentId: "w-9", agentName: "x" }).memory;
    memories.dismiss(old.id);
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.proposed, 0);
    assert.equal(run.dropped.declined, 1);

    const full = setup();
    for (let i = 0; i < DREAM_PENDING_CAP; i++) {
      const topic = ["alpha", "beta", "gamma", "delta", "epsilon"][i];
      full.memories.suggest({ text: `When ${topic} comes up, act.`, category: "work-style", scope: { kind: "global" } }, { kind: "dream", dreamId: `dr-old${i}`, evidence: [] });
    }
    const capped = await dreamOverChats(full.deps, { trigger: "nightly" });
    assert.equal(capped.dropped.capped, 1);
    assert.equal(full.repo.ledger().length, 1);
    assert.equal(repo.ledger().length, 0);
  });
});
