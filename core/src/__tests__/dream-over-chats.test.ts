import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dreamOverChats, type DreamDeps } from "../use-cases/DreamOverChats.ts";
import { UserMemoryService } from "../services/UserMemoryService.ts";
import { emptyUserProfile } from "../domain/user-profile.ts";
import type { DreamRepo } from "../ports/DreamRepo.ts";
import type { DreamLine, DreamSession } from "../domain/dream.ts";
import type { DreamRun } from "../../../contracts/src/dream.ts";
import type { UserMemory, UserProfile } from "../../../contracts/src/profile.ts";

function memRepo(): DreamRepo & { runs: Map<string, DreamRun>; marks: Map<string, number> } {
  const runs = new Map<string, DreamRun>();
  const marks = new Map<string, number>();
  const excluded = new Set<string>();
  return {
    runs, marks,
    save: (r) => { runs.set(r.id, r); },
    get: (id) => runs.get(id) ?? null,
    list: () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt),
    latest: () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null,
    watermark: (id) => marks.get(id) ?? 0,
    setWatermark: (id, e) => { marks.set(id, e); },
    excluded: () => [...excluded],
    setExcluded: (id, on) => { if (on) excluded.add(id); else excluded.delete(id); },
  };
}

const CHATS: DreamSession[] = [
  { workerId: "w-1", name: "profile-design", project: "/eos", noFolder: false, working: false, lastEventId: 30 },
  { workerId: "w-2", name: "stance-ik", project: "/dear-souls", noFolder: false, working: false, lastEventId: 20 },
  { workerId: "w-3", name: "busy", project: "/eos", noFolder: false, working: true, lastEventId: 99 },
];
const LINES: Record<string, DreamLine[]> = {
  "w-1": [{ id: 11, role: "user", text: "bu konu üzerinde detaylıca düşün" }, { id: 12, role: "assistant", text: "Sure." }],
  "w-2": [{ id: 21, role: "user", text: "only change what I asked for" }],
};

const recall = (statement: string, evidence: number[]) =>
  ({ observations: [{ statement, kind: "preference", scope: "global", evidence }] });

const SCHEMAS = { recall: { title: "recall" }, consolidate: { title: "consolidate" } };

function setup(opts: { replies?: (prompt: string) => unknown; stopAfter?: number; profile?: Partial<UserProfile> } = {}) {
  const repo = memRepo();
  const store = new Map<string, UserMemory>();
  let n = 0;
  let now = 1000;
  const memories = new UserMemoryService({
    store: { list: () => [...store.values()], get: (id) => store.get(id) ?? null, put: (m) => { store.set(m.id, m); }, remove: (id) => store.delete(id) },
    clock: { now: () => (now += 1) },
    bus: { publish: () => {} },
    newId: () => `um-dream${String(++n).padStart(4, "0")}`,
  });
  const profile = { ...emptyUserProfile(), ...opts.profile };
  const prompts: string[] = [];
  const schemas: unknown[] = [];
  let summaries = 0;
  const deps: DreamDeps = {
    repo,
    summarizer: {
      summarizeStructured: async ({ prompt, schema }) => {
        prompts.push(prompt);
        schemas.push(schema);
        summaries++;
        if (opts.replies) return opts.replies(prompt);
        if (prompt.startsWith("dream/recall")) {
          return prompt.includes("profile-design") ? recall("Wants a deep think-through first.", [11]) : recall("Keeps diffs surgical.", [21]);
        }
        return {
          narrative: "You asked for depth.",
          proposals: [{ kind: "new", text: "Wants a deep think-through before any design or plan.", category: "work-style", scope: "global", confidence: 3, evidence: [11] }],
          dropped: { oneOff: 2 },
        };
      },
    },
    schemas: SCHEMAS,
    prompts: { render: (id, vars) => `${id} ${JSON.stringify(vars ?? {})}` },
    sessions: () => CHATS,
    lines: (id, after) => (LINES[id] ?? []).filter((l) => l.id > after),
    memories,
    profile: { get: () => profile },
    profileDigest: () => "`<user_profile>` …",
    clock: { now: () => (now += 10) },
    newId: () => "dr-test",
    timeoutMs: 1000,
    shouldStop: () => opts.stopAfter !== undefined && summaries >= opts.stopAfter,
  };
  return { deps, repo, memories, prompts, schemas };
}

describe("dreamOverChats", () => {
  it("reads finished chats, files proposals with evidence, moves watermarks", async () => {
    const { deps, repo, memories, prompts, schemas } = setup();
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.deepEqual(schemas, [SCHEMAS.recall, SCHEMAS.recall, SCHEMAS.consolidate]);
    assert.equal(run.status, "done");
    assert.equal(run.chatsRead, 2); // the working chat is skipped
    assert.equal(run.observations, 2);
    assert.equal(run.proposed, 1);
    assert.equal(run.narrative, "You asked for depth.");
    assert.equal(run.dropped.oneOff, 2);
    assert.ok(run.tokens > 0);
    const filed = memories.list()[0]!;
    assert.equal(filed.status, "suggested");
    assert.deepEqual(filed.proposal, { kind: "new", targets: [], confidence: 3 });
    assert.equal(filed.source.kind, "dream");
    assert.deepEqual(filed.source.kind === "dream" && filed.source.evidence[0], {
      quote: "bu konu üzerinde detaylıca düşün", workerId: "w-1", chat: "profile-design", eventId: 11, by: "user",
    });
    assert.deepEqual([repo.watermark("w-1"), repo.watermark("w-2"), repo.watermark("w-3")], [30, 20, 0]);
    assert.ok(prompts.at(-1)!.includes("o1 · preference"));
    assert.equal(repo.get("dr-test")?.status, "done");
  });

  it("nothing new since the last dream → skipped, no model call", async () => {
    const { deps, repo, prompts } = setup();
    repo.setWatermark("w-1", 30);
    repo.setWatermark("w-2", 20);
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.status, "skipped");
    assert.equal(prompts.length, 0);
  });

  it("excluded projects and chats are never read", async () => {
    const { deps, repo, prompts } = setup({ profile: { dreaming: { ...emptyUserProfile().dreaming, excludedProjects: ["/dear-souls"] } } });
    repo.setExcluded("w-1", true);
    const run = await dreamOverChats(deps, { trigger: "manual" });
    assert.equal(run.status, "skipped");
    assert.equal(prompts.length, 0);
  });

  it("stopping keeps what was read; unread chats keep their watermark", async () => {
    const { deps, repo } = setup({ stopAfter: 1 });
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.status, "stopped");
    assert.equal(run.chatsRead, 1);
    assert.deepEqual([repo.watermark("w-1"), repo.watermark("w-2")], [30, 0]);
  });

  it("a consolidation off its schema fails without filing or moving watermarks", async () => {
    const { deps, repo, memories } = setup({
      replies: (p) => (p.startsWith("dream/recall") ? recall("Something lasting.", [11]) : { proposals: "nope" }),
    });
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.status, "failed");
    assert.equal(memories.list().length, 0);
    assert.equal(repo.watermark("w-1"), 0);
  });

  it("a declined idea counts as declined, not proposed", async () => {
    const { deps, memories } = setup();
    const old = memories.suggest({ text: "Wants a deep think-through before any design or plan.", category: "work-style", scope: { kind: "global" } }, { kind: "agent", agentId: "w-9", agentName: "x" }).memory;
    memories.dismiss(old.id);
    const run = await dreamOverChats(deps, { trigger: "nightly" });
    assert.equal(run.proposed, 0);
    assert.equal(run.dropped.declined, 1);
  });
});
