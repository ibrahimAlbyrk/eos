import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyPageEdit, pageExcerpt, pageTaskCounts } from "../domain/page.ts";
import { PageService, StalePageError } from "../services/PageService.ts";
import { ValidationError, NotFoundError } from "../errors/index.ts";
import type { PageStore } from "../ports/PageStore.ts";
import type { Page, PageAuthor } from "../../../contracts/src/http.ts";

const USER: PageAuthor = { kind: "user", agentId: null, name: null };
const AGENT: PageAuthor = { kind: "agent", agentId: "w-1", name: "Stance IK" };

const BODY = [
  "Intro line with **bold**.",
  "",
  "## Tasks",
  "",
  "- [x] Ground probe per foot",
  "- [ ] Clamp hip offset on stairs",
  "- [ ] Blend IK weight",
  "",
  "```md",
  "- [ ] not a task",
  "## not a heading",
  "```",
  "",
  "## Notes",
  "",
  "Keep the solver pure.",
  "",
].join("\n");

describe("page domain", () => {
  it("counts checklist items outside code fences", () => {
    assert.deepEqual(pageTaskCounts(BODY), { open: 2, done: 1 });
  });

  it("excerpts prose without markdown markers", () => {
    assert.equal(pageExcerpt("# Title\n\n- [ ] first *thing*\n> quoted"), "first thing quoted");
    assert.equal(pageExcerpt("x".repeat(300), 10), `${"x".repeat(9)}…`);
  });

  it("appends at the end, keeping a list together", () => {
    assert.equal(applyPageEdit("", { op: "append", text: "hello" }), "hello\n");
    assert.equal(applyPageEdit("- [ ] a\n", { op: "append", text: "- [ ] b" }), "- [ ] a\n- [ ] b\n");
    assert.equal(applyPageEdit("para\n", { op: "append", text: "more" }), "para\n\nmore\n");
  });

  it("appends to the end of a heading's section", () => {
    const out = applyPageEdit(BODY, { op: "append", text: "- [ ] New task", heading: "tasks" });
    assert.ok(out.includes("```\n\n- [ ] New task\n\n## Notes\n\nKeep the solver pure.\n"));
    const list = applyPageEdit("## Tasks\n\n- [ ] a\n\n## Next\n", { op: "append", text: "- [ ] b", heading: "Tasks" });
    assert.equal(list, "## Tasks\n\n- [ ] a\n- [ ] b\n\n## Next\n");
  });

  it("creates a missing heading at the end", () => {
    const out = applyPageEdit("para\n", { op: "append", text: "found it", heading: "Findings" });
    assert.equal(out, "para\n\n## Findings\n\nfound it\n");
  });

  it("ignores a heading-looking line inside a fence", () => {
    const out = applyPageEdit(BODY, { op: "append", text: "x", heading: "not a heading" });
    assert.ok(out.endsWith("## not a heading\n\nx\n"));
  });

  it("replaces one exact passage, refusing missing or ambiguous text", () => {
    assert.equal(applyPageEdit("a b c", { op: "replace", oldText: "b", newText: "B" }), "a B c");
    assert.throws(() => applyPageEdit("a b c", { op: "replace", oldText: "z", newText: "" }), ValidationError);
    assert.throws(() => applyPageEdit("b b", { op: "replace", oldText: "b", newText: "" }), /appears 2 times/);
  });

  it("ticks and unticks a task by exact or partial text", () => {
    const done = applyPageEdit(BODY, { op: "setTask", task: "clamp hip offset", done: true });
    assert.ok(done.includes("- [x] Clamp hip offset on stairs"));
    const reopened = applyPageEdit(BODY, { op: "setTask", task: "Ground probe per foot", done: false });
    assert.ok(reopened.includes("- [ ] Ground probe per foot"));
    assert.throws(() => applyPageEdit(BODY, { op: "setTask", task: "not a task", done: true }), /no checklist item/);
    assert.throws(() => applyPageEdit(BODY, { op: "setTask", task: "e", done: true }), /matches 3 checklist items/);
  });
});

function memoryStore(): PageStore & { pages: Map<string, Page> } {
  const pages = new Map<string, Page>();
  return {
    pages,
    list: () => [...pages.values()],
    get: (id) => pages.get(id) ?? null,
    put: (p) => { pages.set(p.id, p); },
    remove: (id) => pages.delete(id),
  };
}

function service() {
  const store = memoryStore();
  const events: Array<{ topic: string; payload: unknown }> = [];
  let now = 1000;
  let n = 0;
  const svc = new PageService({
    store,
    clock: { now: () => (now += 1) },
    bus: { publish: (topic, payload) => { events.push({ topic, payload }); } },
    newId: () => `pg-test000${++n}`,
  });
  return { svc, store, events };
}

describe("PageService", () => {
  it("creates, lists by project and query, newest first", () => {
    const { svc, events } = service();
    const a = svc.create({ title: " A ", body: "alpha", project: "/p", agentId: null }, USER);
    svc.create({ title: "B", body: "beta - [ ] x", project: "/q", agentId: null }, AGENT);
    assert.equal(a.title, "A");
    assert.equal(a.rev, 1);
    assert.deepEqual(svc.list({ project: "/p" }).map((p) => p.id), [a.id]);
    assert.deepEqual(svc.list({ query: "BETA" }).map((p) => p.title), ["B"]);
    assert.deepEqual(svc.list().map((p) => p.title), ["B", "A"]);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.topic, "pages:change");
  });

  it("bumps rev on change, skips no-op writes, refuses a stale baseRev", () => {
    const { svc, events } = service();
    const p = svc.create({ title: "T", body: "one", project: null, agentId: null }, USER);
    const same = svc.update(p.id, { body: "one", baseRev: 1 }, USER);
    assert.equal(same.rev, 1);
    const next = svc.update(p.id, { body: "two", baseRev: 1 }, USER);
    assert.equal(next.rev, 2);
    assert.throws(() => svc.update(p.id, { body: "three", baseRev: 1 }, USER), (e: unknown) => e instanceof StalePageError && e.page.rev === 2);
    assert.equal(events.length, 2);
  });

  it("applies targeted edits to the latest body and records the author", () => {
    const { svc } = service();
    const p = svc.create({ title: "T", body: "- [ ] a\n", project: null, agentId: null }, USER);
    const out = svc.edit(p.id, { op: "setTask", task: "a", done: true }, AGENT);
    assert.equal(out.body, "- [x] a\n");
    assert.deepEqual(out.updatedBy, AGENT);
  });

  it("removes and unlinks", () => {
    const { svc, store } = service();
    const p = svc.create({ title: "T", body: "", project: null, agentId: "w-9" }, USER);
    svc.unlinkAgent("w-9");
    assert.equal(store.get(p.id)!.agentId, null);
    svc.remove(p.id, USER);
    assert.throws(() => svc.get(p.id), NotFoundError);
  });
});
