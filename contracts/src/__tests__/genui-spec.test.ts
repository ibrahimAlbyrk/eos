import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GenuiDeltaSchema,
  GenuiSettingsPatchSchema,
  PlacesRequestSchema,
  ViewActionSchema,
  ViewIdSchema,
  ViewRecordSchema,
  ViewStateSchema,
  genuiRejection,
  newViewId,
  validateApp,
} from "../genui/spec.ts";
import { parseBest, parseChips, parseCols, parseOptions, parseSort, splitIds, splitLabels, attrBool, attrNum } from "../genui/attrs.ts";
import { MessageRecordSchema, MessageRequestSchema } from "../http.ts";

describe("view ids", () => {
  it("validates the v_ + 12 base62 shape", () => {
    assert.equal(ViewIdSchema.safeParse("v_7Hq2abcdEFGH").success, true);
    for (const bad of ["v_7Hq2", "v_7Hq2abcdEFG!", "x_7Hq2abcdEFGH", "v_7Hq2abcdEFGHI"]) assert.equal(ViewIdSchema.safeParse(bad).success, false, bad);
  });

  it("mints fresh, well-formed ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newViewId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^v_[A-Za-z0-9]{12}$/);
    assert.equal(newViewId((b) => b.fill(0)), "v_AAAAAAAAAAAA");
  });
});

describe("view actions on messages", () => {
  const action = { viewId: "v_7Hq2abcdEFGH", actionId: "book", label: "Masa ayırt", viewTitle: "Kadıköy'de bu akşam", item: "moda", state: { party: 2 } };

  it("MessageRequestSchema carries an optional action", () => {
    assert.equal(MessageRequestSchema.safeParse({ text: "Moda Kıyı için masa ayırt" }).success, true);
    const r = MessageRequestSchema.safeParse({ text: "Moda Kıyı için masa ayırt", action });
    assert.ok(r.success);
    assert.deepEqual(r.data.action, action);
    assert.equal(MessageRequestSchema.safeParse({ text: "x", action: { ...action, viewId: "nope" } }).success, false);
    assert.equal(ViewActionSchema.safeParse({ ...action, item: { id: "moda", name: "Moda Kıyı" } }).success, true);
  });

  it("the stored user_message keeps {viewId, label, viewTitle}", () => {
    const r = MessageRecordSchema.safeParse({ as: "user_message", displayText: "Masa ayırt", action: { viewId: action.viewId, label: "Masa ayırt", viewTitle: "Kadıköy'de bu akşam" } });
    assert.ok(r.success);
    assert.deepEqual((r.data as { action?: unknown }).action, { viewId: action.viewId, label: "Masa ayırt", viewTitle: "Kadıköy'de bu akşam" });
  });
});

describe("stored views and state", () => {
  it("discriminates view and app records", () => {
    const view = { id: "v_7Hq2abcdEFGH", workerId: "w1", kind: "view", title: "T", createdAt: 1, spec: { title: "T", ui: "<Divider/>", summary: "s" } };
    const app = { id: "v_7Hq2abcdEFGI", workerId: "w1", kind: "app", title: "A", createdAt: 1, spec: { title: "A", html: "<p>x</p>", summary: "s", height: 300 } };
    assert.equal(ViewRecordSchema.safeParse(view).success, true);
    assert.equal(ViewRecordSchema.safeParse(app).success, true);
    assert.equal(ViewRecordSchema.safeParse({ ...app, kind: "view" }).success, false);
  });

  it("caps view state at 32 KB", () => {
    assert.equal(ViewStateSchema.safeParse({ filters: { places: [0, 2] }, step: 3 }).success, true);
    assert.equal(ViewStateSchema.safeParse({ blob: "x".repeat(33 * 1024) }).success, false);
  });

  it("streams deltas with a phase", () => {
    assert.equal(GenuiDeltaSchema.safeParse({ workerId: "w", callId: "c", name: "mcp__orchestrator__present", phase: "append", text: "{\"ti" }).success, true);
    assert.equal(GenuiDeltaSchema.safeParse({ workerId: "w", callId: "c", name: "x", phase: "middle", text: "" }).success, false);
  });

  it("formats a rejection for the tool", () => {
    const r = genuiRejection([{ path: "summary", message: "is required" }]);
    assert.deepEqual(r.problems, [{ path: "summary", message: "is required" }]);
    assert.equal(r.error, "1 problem — nothing rendered\n· summary: is required\nfix and call present again");
  });
});

describe("route bodies", () => {
  it("places need a query or a category and a point or text", () => {
    assert.equal(PlacesRequestSchema.safeParse({ query: "meyhane", near: { lat: 40.98, lon: 29.02 } }).success, true);
    assert.equal(PlacesRequestSchema.safeParse({ category: "restaurant", near: { text: "Kadıköy" }, radiusM: 1500, limit: 10 }).success, true);
    assert.equal(PlacesRequestSchema.safeParse({ near: { text: "Kadıköy" } }).success, false);
    assert.equal(PlacesRequestSchema.safeParse({ query: "x", near: { lat: 99, lon: 0 } }).success, false);
  });

  it("the logo key must be publishable", () => {
    assert.equal(GenuiSettingsPatchSchema.safeParse({ logoDevKey: "pk_AbC123xyz" }).success, true);
    assert.equal(GenuiSettingsPatchSchema.safeParse({ logoDevKey: "sk_secret123" }).success, false);
    assert.equal(GenuiSettingsPatchSchema.safeParse({ logoDevKey: null, level: "rich", locationShare: true }).success, true);
    assert.equal(GenuiSettingsPatchSchema.safeParse({ level: "max" }).success, false);
  });
});

describe("validateApp", () => {
  const ok = { title: "Timer", html: "<!doctype html><html><body><p>hi</p></body></html>", summary: "A timer." };
  it("accepts one document", () => {
    assert.equal(validateApp(ok).ok, true);
    assert.equal(validateApp({ ...ok, height: 720 }).ok, true);
  });

  it("rejects each limit with its path", () => {
    const r = validateApp({ ...ok, height: 900, html: `${ok.html}${ok.html}`, summary: "" });
    assert.equal(r.ok, false);
    const lines = r.ok ? [] : r.problems.map((p) => `${p.path}: ${p.message}`);
    assert.deepEqual(lines, ["summary: is required — what the app does, in plain text", "height: 900 is outside 200–720", "html: holds 2 <html> documents — send one"]);
    const big = validateApp({ ...ok, html: `<p>${"x".repeat(257 * 1024)}</p>` });
    assert.equal(big.ok, false);
    assert.match(big.ok ? "" : big.problems[0].message, /^is 257 KB, max 256 KB/);
  });

  it("warns about external files", () => {
    const r = validateApp({ ...ok, html: '<script src="https://cdn.example/x.js"></script><p>x</p>' });
    assert.ok(r.ok);
    assert.match(r.warnings[0].message, /sandbox blocks the network/);
  });
});

describe("attribute readers", () => {
  it("split id and label lists", () => {
    assert.deepEqual(splitIds("book route,  menu"), ["book", "route", "menu"]);
    assert.deepEqual(splitIds(["a", 2]), ["a", "2"]);
    assert.deepEqual(splitLabels("Evet, olur | Hayır"), ["Evet, olur", "Hayır"]);
    assert.deepEqual(splitLabels("A, B , C"), ["A", "B", "C"]);
    assert.deepEqual(splitLabels([{ label: "X" }, "Y"]), ["X", "Y"]);
  });

  it("read column specs", () => {
    assert.deepEqual(parseCols("name rating price"), [
      { key: "name", label: "name" },
      { key: "rating", label: "rating" },
      { key: "price", label: "price" },
    ]);
    assert.deepEqual(parseCols("aspect:, merge:Merge, rebase:Rebase"), [
      { key: "aspect", label: "" },
      { key: "merge", label: "Merge" },
      { key: "rebase", label: "Rebase" },
    ]);
    assert.deepEqual(parseCols([{ key: "name", label: "Mekan" }, "rating"]), [
      { key: "name", label: "Mekan" },
      { key: "rating", label: "rating" },
    ]);
  });

  it("read chips, options, best and sort", () => {
    assert.deepEqual(parseChips("Şu an açık: open, ₺–₺₺: price<=2, tags~sea"), [
      { label: "Şu an açık", where: "open" },
      { label: "₺–₺₺", where: "price<=2" },
      { label: "tags~sea", where: "tags~sea" },
    ]);
    assert.deepEqual(parseChips([{ label: "Open", where: "open" }]), [{ label: "Open", where: "open" }]);
    assert.deepEqual(parseOptions("Cumartesi | Pazar"), [
      { label: "Cumartesi", value: "Cumartesi" },
      { label: "Pazar", value: "Pazar" },
    ]);
    assert.deepEqual(parseOptions([{ label: "Sat", value: "sat" }, "Sun"]), [
      { label: "Sat", value: "sat" },
      { label: "Sun", value: "Sun" },
    ]);
    assert.equal(parseBest(true), "auto");
    assert.deepEqual(parseBest("rating:max price:min"), { rating: "max", price: "min" });
    assert.equal(parseBest(undefined), null);
    assert.deepEqual(parseSort("-rating"), { field: "rating", desc: true });
    assert.equal(attrBool("false", true), false);
    assert.equal(attrBool(true), true);
    assert.equal(attrNum("12"), 12);
    assert.equal(attrNum("x", 3), 3);
  });
});
