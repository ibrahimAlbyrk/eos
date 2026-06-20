import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir, homedir } from "node:os";
import { GitEvidenceCollector } from "../goalcheck/GitEvidenceCollector.ts";
import type { GoalSpec } from "../../../contracts/src/loop.ts";
import type { GoalContext } from "../../../core/src/ports/GoalCheckStrategy.ts";

function collector(fullDiff: (cwd: string, base?: string) => Promise<string | null>) {
  return new GitEvidenceCollector({ git: { fullDiff }, repoRoot: tmpdir() });
}

// A collector backed by an in-memory filesystem so file-evidence tests stay
// deterministic. A path absent from the map rejects — the real "file missing".
function fileCollector(disk: Record<string, string>) {
  return new GitEvidenceCollector({
    git: { fullDiff: async () => null },
    repoRoot: "/repo",
    readFile: async (p: string) => {
      if (!(p in disk)) throw new Error(`ENOENT: ${p}`);
      return disk[p];
    },
  });
}

describe("GitEvidenceCollector", () => {
  it("runs each verify command into a machine signal (exit code captured); skips no-verify criteria", async () => {
    const goal: GoalSpec = { summary: "g", criteria: [
      { id: "c1", text: "ok", verify: "exit 0" },
      { id: "c2", text: "bad", verify: "exit 2" },
      { id: "c3", text: "subjective" },
    ] };
    const bundle = await collector(async () => null).collect(goal, { workerId: "w-1", attempt: 0 });
    assert.equal(bundle.machineSignals.length, 2);
    assert.deepEqual(bundle.machineSignals.map((s) => [s.criterionId, s.exitCode]), [["c1", 0], ["c2", 2]]);
  });

  it("includes the git diff when a worktree dir is present; truncates oversized diffs", async () => {
    const goal: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "t" }] };
    const big = "x".repeat(60000);
    const ctx: GoalContext = { workerId: "w-1", attempt: 0, worktreeDir: "/wt", forkBaseSha: "base" };
    const bundle = await collector(async () => big).collect(goal, ctx);
    assert.ok(bundle.diff);
    assert.ok(bundle.diff!.includes("...[truncated]"));
    assert.ok(bundle.diff!.length < big.length);
  });

  it("omits the diff when there is no worktree dir; carries the report claim through", async () => {
    const goal: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "t" }] };
    const bundle = await collector(async () => "should-not-be-used").collect(goal, { workerId: "w-1", attempt: 0, lastReportText: "my claim" });
    assert.equal(bundle.diff, undefined);
    assert.equal(bundle.reportClaim, "my claim");
  });

  it("reads an absolute file a criterion references — a valid artifact becomes real evidence", async () => {
    const goal: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "A valid haiku exists at /tmp/haiku.txt." }] };
    const bundle = await fileCollector({ "/tmp/haiku.txt": "old pond\na frog leaps in\nwater's sound" })
      .collect(goal, { workerId: "w-1", attempt: 0 });
    assert.equal(bundle.files?.length, 1);
    assert.equal(bundle.files?.[0].path, "/tmp/haiku.txt");
    assert.match(bundle.files![0].content, /frog leaps/);
  });

  it("resolves a relative path against the worktree dir", async () => {
    const goal: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "see ./out/result.json" }] };
    const bundle = await fileCollector({ "/wt/out/result.json": "{\"ok\":true}" })
      .collect(goal, { workerId: "w-1", attempt: 0, worktreeDir: "/wt" });
    assert.equal(bundle.files?.length, 1);
    assert.equal(bundle.files?.[0].path, "/wt/out/result.json");
  });

  it("a referenced file that is absent yields NO file evidence (judge stays fail-closed → unmet)", async () => {
    const goal: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "output at /tmp/missing.txt" }] };
    const bundle = await fileCollector({}).collect(goal, { workerId: "w-1", attempt: 0 });
    assert.equal(bundle.files, undefined);
  });

  it("expands a leading ~/ to the homedir (path.resolve would not)", async () => {
    const abs = `${homedir()}/notes/x.txt`;
    const goal: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "artifact at ~/notes/x.txt" }] };
    const bundle = await fileCollector({ [abs]: "home artifact" }).collect(goal, { workerId: "w-1", attempt: 0 });
    assert.equal(bundle.files?.length, 1);
    assert.equal(bundle.files?.[0].path, abs);
  });

  it("never reads paths from the worker's report claim — only the criteria (robust against false prose)", async () => {
    const goal: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "the goal is met" }] };
    const bundle = await fileCollector({ "/tmp/proof.txt": "fabricated" })
      .collect(goal, { workerId: "w-1", attempt: 0, lastReportText: "I wrote the proof at /tmp/proof.txt, trust me" });
    assert.equal(bundle.files, undefined);
    assert.equal(bundle.reportClaim, "I wrote the proof at /tmp/proof.txt, trust me");
  });
});
