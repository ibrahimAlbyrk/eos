import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { ASK_AFTER_MS, createIntentAsker, GIVE_UP_MS, intentKey, READING_AFTER_MS, readingOf } from "./intentAsk.js";
import { initialInput, inputReducer, phaseOf } from "./inputReducer.js";
import { choiceLine, IDLE_HINT, MAKE_LINE, runLine } from "./intentWords.js";
import { readIntent } from "./localIntent.js";
import { actionable, needsCore, optionsOf, verdictOf } from "./verdict.js";
import { lineOf } from "../IntentLine.jsx";

const VECTORS = JSON.parse(readFileSync(new URL("../../../../../../../fixtures/routines/intent-vectors.json", import.meta.url), "utf8"));
const rowsOf = (vector) => vector.routines.map((r) => ({ id: r.id, name: r.name, slug: r.slug, aliases: r.aliases, takes: { itemPatterns: r.itemPatterns } }));
const ROUTINES = rowsOf(VECTORS[0]);
const read = (text, extra = {}) => readIntent({ text, ...extra }, ROUTINES);

afterEach(() => vi.useRealTimers());

describe("the dashboard's intent rules", () => {
  it("agree with the core on every shared vector", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20);
    for (const v of VECTORS) {
      const reading = readIntent({ text: v.text }, rowsOf(v));
      expect([v.text, reading.intent, reading.certain, reading.routineId]).toEqual([v.text, v.expect.intent, true, v.expect.routineId ?? null]);
    }
  });

  it("keep the item as written", () => {
    expect(read("review #470").item).toBe("#470");
    expect(read("please look at #88").item).toBe("#88");
    expect(read("PR Review").item).toBe(null);
  });

  it("are unsure of anything else, and offer making and doing it once", () => {
    const reading = read("write a haiku about rain");
    expect(reading).toMatchObject({ intent: "unsure", certain: false });
    expect(reading.alternatives.map((c) => c.intent)).toEqual(["make", "once"]);
  });

  it("offer a run of each routine named twice over, with no model", () => {
    const routines = [...ROUTINES, { id: "rt-rev2", name: "Code Review", slug: "code-review", aliases: ["review"], takes: { itemPatterns: [] } }];
    const reading = readIntent({ text: "review the shop" }, routines);
    expect(reading.alternatives.map((c) => c.routineId)).toEqual(["rt-pr", "rt-rev2", null]);
    expect(needsCore(reading)).toBe(false);
    expect(needsCore(read("write a haiku"))).toBe(true);
  });

  it("follow a forced mode, and a picked routine", () => {
    expect(read("every morning summarise", { forced: "once" })).toMatchObject({ intent: "once", certain: true });
    expect(read("write a haiku", { forced: "run" }).intent).toBe("unsure");
    expect(read("#12", { forced: "run" })).toMatchObject({ intent: "run", routineId: "rt-pr", item: "#12" });
    expect(read("#12", { routineId: "rt-mail" })).toMatchObject({ intent: "run", routineId: "rt-mail" });
    expect(read("that one", { attachments: ["/Users/a/acme.pdf"] })).toMatchObject({ intent: "run", routineId: "rt-inv", item: "/Users/a/acme.pdf" });
  });

  it("read a sentence against 200 routines within a millisecond on average", () => {
    const many = Array.from({ length: 200 }, (_, n) => ({ id: `r${n}`, name: `Routine ${n}`, slug: `routine-${n}`, aliases: [`alias${n}`], takes: { itemPatterns: ["(?:^|\\s)#(\\d+)\\b"] } }));
    readIntent({ text: "warm up" }, many);
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) readIntent({ text: `routine-${i} should stop at 5pm #7` }, many);
    expect((performance.now() - started) / 50).toBeLessThan(1);
  });
});

describe("asking the core", () => {
  const answer = (body) => ({ ok: true, status: 200, body: { certain: true, alternatives: [], options: {}, source: "model", ...body } });

  it("waits 250 ms, says Reading after 400 ms, and applies only its latest answer", async () => {
    vi.useFakeTimers();
    const sent = [];
    const asker = createIntentAsker((body) => new Promise((resolve) => sent.push({ body, resolve })), () => {});
    asker.ask({ text: "look at the carousel" });
    expect(asker.state().status).toBe("waiting");
    await vi.advanceTimersByTimeAsync(ASK_AFTER_MS);
    expect(sent).toHaveLength(1);
    asker.ask({ text: "look at the shop carousel" });
    await vi.advanceTimersByTimeAsync(ASK_AFTER_MS);
    sent[0].resolve(answer({ intent: "once", line: "Do it once", seq: sent[0].body.seq }));
    await vi.advanceTimersByTimeAsync(READING_AFTER_MS - ASK_AFTER_MS);
    expect(asker.state().status).toBe("slow");
    sent[1].resolve(answer({ intent: "make", line: "Make", seq: sent[1].body.seq }));
    await vi.advanceTimersByTimeAsync(0);
    expect(asker.state()).toMatchObject({ status: "answered", reading: { intent: "make", certain: true } });
  });

  it("answers a repeat at once, and gives up after 4.5 s", async () => {
    vi.useFakeTimers();
    let next = null;
    const asker = createIntentAsker((body) => (next ? next(body) : new Promise(() => {})), () => {});
    next = (body) => answer({ intent: "once", line: "Once", seq: body.seq });
    asker.ask({ text: "Tidy  the notes" });
    await vi.advanceTimersByTimeAsync(ASK_AFTER_MS);
    asker.stop();
    next = null;
    asker.ask({ text: "tidy the notes " });
    expect(asker.state().status).toBe("answered");
    asker.ask({ text: "something new" });
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
    expect(asker.state().status).toBe("failed");
  });

  it("keys on the normalised text and what came with it", () => {
    expect(intentKey({ text: " Hello  World " })).toBe(intentKey({ text: "hello world" }));
    expect(intentKey({ text: "x", attachments: [{ kind: "link", value: "a" }] })).not.toBe(intentKey({ text: "x" }));
  });

  it("reads an unsure model answer as choices", () => {
    const reading = readingOf({ intent: "run", certain: false, routineId: "rt-pr", line: "Run PR Review on the latest", alternatives: [{ intent: "once", line: "Do it once, here" }] });
    expect(reading.certain).toBe(false);
    expect(reading.alternatives.map((c) => c.intent)).toEqual(["run", "once"]);
  });
});

describe("the input reducer and Enter", () => {
  const sure = { kind: "sure", reading: { ...read("review #470") } };

  it("cycles alternatives with Tab only while there are two or more", () => {
    let s = inputReducer(initialInput, { type: "tab", step: 1, count: 2, sure: true });
    expect(s).toMatchObject({ tab: 1, tabbed: true });
    s = inputReducer(s, { type: "tab", step: 1, count: 2, sure: true });
    expect(s.tab).toBe(0);
    expect(inputReducer(initialInput, { type: "tab", step: 1, count: 1 })).toBe(initialInput);
    expect(inputReducer(s, { type: "typed" })).toMatchObject({ tab: 0, tabbed: false });
  });

  it("acts on a sure reading, and on an unsure one only after Tab", () => {
    expect(actionable(sure, initialInput)).toMatchObject({ intent: "run", routineId: "rt-pr" });
    expect(actionable(sure, { ...initialInput, tab: 1 })).toMatchObject({ intent: "once" });
    const choices = { kind: "choices", reading: read("write a haiku") };
    expect(actionable(choices, initialInput)).toBe(null);
    const tabbed = inputReducer(initialInput, { type: "tab", step: 1, count: 2, sure: false });
    expect(actionable(choices, tabbed)).toMatchObject({ intent: "make" });
    expect(actionable({ kind: "waiting" }, initialInput)).toBe(null);
  });

  it("names its phases", () => {
    const local = read("write a haiku");
    const v = (text, asked = { status: "waiting" }) => verdictOf({ text, local: text === "" ? read("") : local, asked });
    expect(phaseOf(initialInput, "", v(""))).toBe("idle");
    expect(phaseOf(initialInput, "/pr", verdictOf({ text: "/pr", local, asked: {} }))).toBe("menu");
    expect(phaseOf(initialInput, "write a haiku", v("write a haiku"))).toBe("waiting");
    expect(phaseOf(initialInput, "write a haiku", v("write a haiku", { status: "failed" }))).toBe("choices");
    expect(phaseOf({ ...initialInput, routineId: "rt-pr" }, "", v(""))).toBe("token");
    expect(optionsOf(v("write a haiku", { status: "failed" })).map((c) => c.intent)).toEqual(["make", "once", "menu"]);
  });
});

describe("the intent line", () => {
  const byId = new Map(ROUTINES.map((r) => [r.id, { ...r, rung: "draft", takes: { ...r.takes, kind: "github.pull_request", label: "pull request" } }]));

  it("says what Enter will do in the routine's words", () => {
    expect(choiceLine({ intent: "run", routineId: "rt-pr", item: "#470" }, byId)).toBe("Run PR Review on #470, draft for you");
    expect(choiceLine({ intent: "run", routineId: "rt-pr", item: null }, byId)).toBe("Run PR Review on the latest pull request, draft for you");
    expect(runLine({ name: "Paper", takes: { kind: "none" } }, null, { showOnly: true })).toBe("Run Paper, shown to you only");
    expect(choiceLine({ intent: "make" }, byId)).toBe(MAKE_LINE);
  });

  it("dims the last line while the core decides, then says Reading and Deciding", () => {
    const input = initialInput;
    expect(lineOf({ verdict: { kind: "idle" }, options: [], input, byId }).text).toBe(IDLE_HINT);
    const previous = { text: "Run PR Review on #470, draft for you", enter: true };
    expect(lineOf({ verdict: { kind: "waiting" }, options: [], input, byId, previous })).toMatchObject({ text: previous.text, dim: true });
    expect(lineOf({ verdict: { kind: "waiting", slow: true }, options: [], input, byId, previous }).text).toBe("Reading…");
    expect(lineOf({ verdict: { kind: "waiting" }, options: [], input: { ...input, pendingEnter: true }, byId }).text).toBe("Deciding…");
  });
});
