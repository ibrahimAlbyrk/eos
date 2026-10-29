import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ArtifactCatalogService, type ArtifactLogin } from "../services/ArtifactCatalogService.ts";
import { announcesArtifact, mergeArtifacts } from "../domain/artifact-catalog.ts";
import type { ArtifactSource } from "../ports/ArtifactSource.ts";
import type { ArtifactCatalog, ArtifactSummary } from "../../../contracts/src/artifacts.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

const row = (slug: string, updatedAt: string, over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  slug, url: `https://claude.ai/artifact/${slug}`, title: slug, kind: "Page", rel: "mine", updatedAt, loginId: "a", ...over,
});

const settle = () => new Promise<void>((r) => setImmediate(r));

interface Call {
  loginId: string;
  resolve: (rows: ArtifactSummary[]) => void;
  reject: (e: Error) => void;
}

function harness(initial: ArtifactLogin[] = [{ id: "a", label: "Personal", email: "me@x.com" }]) {
  let logins = initial;
  let now = Date.UTC(2026, 9, 29, 12);
  const calls: Call[] = [];
  const published: ArtifactCatalog[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const source: ArtifactSource = {
    list: (loginId) => new Promise((resolve, reject) => { calls.push({ loginId, resolve, reject }); }),
  };
  const svc = new ArtifactCatalogService({
    source,
    logins: () => logins,
    clock: { now: () => now },
    publish: (c) => { published.push(c); },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  return {
    svc, calls, published, timers,
    setLogins: (l: ArtifactLogin[]) => { logins = l; },
    advance: (ms: number) => { now += ms; },
    // Answers the oldest open read of a sign-in.
    answer: async (loginId: string, rows: ArtifactSummary[] | Error) => {
      const i = calls.findIndex((c) => c.loginId === loginId);
      assert.ok(i >= 0, `no open read for ${loginId}`);
      const [c] = calls.splice(i, 1);
      if (rows instanceof Error) c.reject(rows); else c.resolve(rows);
      await settle();
    },
  };
}

describe("ArtifactCatalogService", () => {
  it("one read per sign-in at a time: concurrent refreshes share it", async () => {
    const t = harness();
    const one = t.svc.refresh();
    const two = t.svc.refresh("a");
    await settle();
    assert.equal(t.calls.length, 1);
    await t.answer("a", [row("s1", "2026-10-29T10:00:00Z")]);
    const [c1, c2] = await Promise.all([one, two]);
    assert.deepEqual(c1, c2);
    assert.deepEqual(c1.artifacts.map((a) => a.slug), ["s1"]);
    assert.deepEqual(c1.accounts, [{
      loginId: "a", label: "Personal", email: "me@x.com", count: 1, refreshedAt: "2026-10-29T12:00:00.000Z",
    }]);
    assert.equal(c1.refreshing, false);
  });

  it("get() answers from memory and re-reads a sign-in never read or stale", async () => {
    const t = harness();
    const first = t.svc.get();
    assert.deepEqual(first.artifacts, []);
    assert.equal(first.refreshing, true);
    await settle();
    assert.equal(t.calls.length, 1);
    t.svc.get();
    await settle();
    assert.equal(t.calls.length, 1, "a read in flight is not started again");
    await t.answer("a", [row("s1", "2026-10-29T10:00:00Z")]);

    t.advance(59_000);
    assert.equal(t.svc.get().refreshing, false);
    await settle();
    assert.equal(t.calls.length, 0, "fresh: no read");

    t.advance(1_000);
    const stale = t.svc.get();
    assert.deepEqual(stale.artifacts.map((a) => a.slug), ["s1"], "the old list while it re-reads");
    assert.equal(stale.refreshing, true);
    await settle();
    assert.equal(t.calls.length, 1);
  });

  it("publishes when a read starts (refreshing flips) and when it ends", async () => {
    const t = harness([{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    t.svc.get();
    assert.deepEqual(t.published.map((c) => c.refreshing), [true], "two reads, one flip");
    await settle();
    await t.answer("a", [row("s1", "2026-10-29T10:00:00Z")]);
    await t.answer("b", []);
    assert.deepEqual(t.published.map((c) => c.refreshing), [true, true, false]);
    assert.deepEqual(t.published[1].artifacts.map((a) => a.slug), ["s1"]);
  });

  it("a failed read keeps the sign-in's last list and says why; the next success clears it", async () => {
    const t = harness();
    const p1 = t.svc.refresh();
    await settle();
    await t.answer("a", [row("s1", "2026-10-29T10:00:00Z"), row("s2", "2026-10-29T09:00:00Z")]);
    await p1;

    t.advance(5_000);
    const p2 = t.svc.refresh();
    await settle();
    await t.answer("a", new Error("Sign in to this account again under Settings › Accounts."));
    const failed = await p2;
    assert.deepEqual(failed.artifacts.map((a) => a.slug), ["s1", "s2"]);
    assert.deepEqual(failed.accounts[0], {
      loginId: "a", label: "Personal", email: "me@x.com", count: 2,
      refreshedAt: "2026-10-29T12:00:00.000Z", error: "Sign in to this account again under Settings › Accounts.",
    });

    // A failure counts as a read for staleness, so get() doesn't retry it at once.
    t.svc.get();
    await settle();
    assert.equal(t.calls.length, 0);

    const p3 = t.svc.refresh();
    await settle();
    await t.answer("a", [row("s3", "2026-10-29T11:00:00Z")]);
    const ok = await p3;
    assert.equal(ok.accounts[0].error, undefined);
    assert.equal(ok.accounts[0].refreshedAt, "2026-10-29T12:00:05.000Z");
    assert.deepEqual(ok.artifacts.map((a) => a.slug), ["s3"]);
  });

  it("merges every sign-in newest first, one row per artifact, the owner's row winning", async () => {
    const t = harness([{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    const p = t.svc.refresh();
    await settle();
    await t.answer("a", [row("x", "2026-10-29T08:00:00Z", { rel: "shared" }), row("old", "2026-10-01T00:00:00Z")]);
    await t.answer("b", [row("x", "2026-10-29T08:00:00Z", { loginId: "b" }), row("new", "2026-10-29T11:00:00Z", { loginId: "b" })]);
    const c = await p;
    assert.deepEqual(c.artifacts.map((a) => [a.slug, a.loginId, a.rel]), [
      ["new", "b", "mine"], ["x", "b", "mine"], ["old", "a", "mine"],
    ]);
    assert.deepEqual(c.accounts.map((a) => [a.loginId, a.count]), [["a", 2], ["b", 2]]);
  });

  it("drops a sign-in that is gone, and the answer of a read it had in flight", async () => {
    const t = harness([{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    const p = t.svc.refresh();
    await settle();
    await t.answer("a", [row("s1", "2026-10-29T10:00:00Z")]);
    await t.answer("b", [row("s2", "2026-10-29T11:00:00Z", { loginId: "b" })]);
    await p;

    t.setLogins([{ id: "b", label: "B" }]);
    const c = t.svc.get();
    assert.deepEqual(c.artifacts.map((a) => a.slug), ["s2"]);
    assert.deepEqual(c.accounts.map((a) => a.loginId), ["b"]);

    t.setLogins([{ id: "b", label: "B" }, { id: "c", label: "C" }]);
    t.svc.get();
    await settle();
    t.setLogins([{ id: "b", label: "B" }]);
    await t.answer("c", [row("s3", "2026-10-29T12:00:00Z", { loginId: "c" })]);
    assert.deepEqual(t.svc.get().artifacts.map((a) => a.slug), ["s2"]);
  });

  it("invalidate() coalesces a burst into one read per sign-in after the debounce", async () => {
    const t = harness([{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }]);
    t.svc.invalidate("a");
    t.svc.invalidate("a");
    t.svc.invalidate("b");
    t.svc.invalidate("gone");
    assert.equal(t.timers.length, 1);
    assert.equal(t.timers[0].ms, 1500);
    await settle();
    assert.equal(t.calls.length, 0, "nothing read before the timer fires");
    t.timers[0].fn();
    await settle();
    assert.deepEqual(t.calls.map((c) => c.loginId).sort(), ["a", "b"]);
    await t.answer("a", []);
    await t.answer("b", []);

    t.svc.invalidate("a");
    t.svc.invalidate();
    assert.equal(t.timers.length, 2);
    t.timers[1].fn();
    await settle();
    assert.deepEqual(t.calls.map((c) => c.loginId).sort(), ["a", "b", "c"], "no id = every sign-in");
  });

  it("an invalidation during a read reads again once that read ends", async () => {
    const t = harness();
    const p = t.svc.refresh();
    await settle();
    t.svc.invalidate("a");
    t.svc.invalidate("a");
    t.timers[0].fn();
    await settle();
    assert.equal(t.calls.length, 1, "joins nothing, starts nothing while one is in flight");
    await t.answer("a", [row("s1", "2026-10-29T10:00:00Z")]);
    await p;
    assert.equal(t.calls.length, 1, "the follow-up read");
    assert.equal(t.svc.get().refreshing, true);
    await t.answer("a", [row("s2", "2026-10-29T11:00:00Z"), row("s1", "2026-10-29T10:00:00Z")]);
    assert.equal(t.calls.length, 0);
    assert.deepEqual(t.published.at(-1)?.artifacts.map((a) => a.slug), ["s2", "s1"]);
    assert.equal(t.published.at(-1)?.refreshing, false);
  });
});

describe("mergeArtifacts", () => {
  it("keeps the newer of two rows of the same relation and sorts unparsable times last", () => {
    const merged = mergeArtifacts([
      [row("x", "2026-10-29T08:00:00Z"), row("bad", "not a date")],
      [row("x", "2026-10-29T09:00:00+00:00", { loginId: "b", title: "newer" }), row("y", "2026-10-29T08:30:00Z")],
    ]);
    assert.deepEqual(merged.map((a) => [a.slug, a.title]), [["x", "newer"], ["y", "y"], ["bad", "bad"]]);
  });
});

describe("announcesArtifact", () => {
  const result = (content: string): AgentEvent => ({
    type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "c1", isError: false, content }],
  });

  it("matches a tool result holding a claude.ai artifact link, in either form", () => {
    assert.equal(announcesArtifact(result("Published: https://claude.ai/artifact/BLUSnX4ryWVrJkeDQtv9mP")), true);
    assert.equal(announcesArtifact(result("https://claude.ai/code/artifact/0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b")), true);
    assert.equal(announcesArtifact(result("see https://preview.claude.com/artifact/abc")), true);
  });

  it("ignores other links, other blocks and other events", () => {
    assert.equal(announcesArtifact(result("https://claude.ai/chat/123 and http://claude.ai/artifact/x")), false);
    assert.equal(announcesArtifact({
      type: "message", role: "assistant", blocks: [{ type: "text", text: "https://claude.ai/artifact/BLUSnX4ryWVrJkeDQtv9mP" }],
    } as AgentEvent), false);
    assert.equal(announcesArtifact({ type: "turn", phase: "ended" }), false);
  });
});
