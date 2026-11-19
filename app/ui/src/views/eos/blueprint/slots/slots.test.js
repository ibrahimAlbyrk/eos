import { describe, it, expect } from "vitest";
import { changedSlots, slotText, SLOTS } from "./index.js";
import { goesToParts } from "./goesTo.js";
import { howParts } from "./how.js";
import { localZone, whenParts } from "./when.js";
import { whichParts } from "./which.js";
import { whoParts } from "./who.js";
import { freedomQuestion, withRung } from "../FreedomLadder.jsx";

const part = (parts, key) => parts.find((p) => typeof p === "object" && p.key === key);
const words = (parts) => parts.map((p) => (typeof p === "string" ? p : p.break ? "|" : p.text)).join("");
const slot = (key) => SLOTS.find((s) => s.key === key);

describe("the When slot", () => {
  const daily = { schedule: { daily: "07:30", days: "weekdays", zone: "Europe/Istanbul", future: 1 }, later: true };
  const when = { on: [daily], limits: { perHour: 10, queued: 5 }, batch: { max: 5, waitMinutes: 2 }, unknown: "kept" };

  it("says a daily schedule and changes its days and time, keeping every other key", () => {
    const parts = whenParts(when);
    expect(words(parts.filter((p) => p.editor !== "act"))).toContain("Runs on weekdays at 07:30");
    const days = part(parts, "0.days");
    expect(days.editor).toBe("menu");
    expect(days.options.map((o) => o.value)).toEqual(["all", "weekdays"]);
    const next = days.apply("all");
    expect(next).toEqual({ ...when, on: [{ ...daily, schedule: { ...daily.schedule, days: "all" } }] });

    const time = part(parts, "0.daily");
    expect(time.check("7")).toBe("A time such as 07:30");
    expect(time.check("18:05")).toBe(true);
    expect(time.apply("18:05").on[0].schedule).toEqual({ daily: "18:05", days: "weekdays", zone: "Europe/Istanbul", future: 1 });
  });

  it("says every N minutes and a monthly day, and offers the Mac's zone in one tap when it differs", () => {
    const every = whenParts({ on: [{ schedule: { every: 30, between: ["09:00", "17:00"], days: ["mon", "fri"], zone: localZone() } }] });
    expect(words(every.filter((p) => p.editor !== "act"))).toBe("Every 30 minutes from 09:00 to 17:00 on Mon, Fri ");
    expect(part(every, "0.every").apply("45").on[0].schedule.every).toBe(45);
    expect(part(every, "0.zone")).toBeUndefined();

    const monthly = whenParts({ on: [{ schedule: { monthly: "last", at: "18:00", zone: "Mars/Olympus" } }] });
    expect(words(monthly.filter((p) => p.editor !== "act"))).toContain("On the last day of each month at 18:00 (Mars/Olympus time)");
    expect(part(monthly, "0.monthly").check("32")).toBe("1 to 31, or last");
    expect(part(monthly, "0.monthly").apply("3").on[0].schedule.monthly).toBe(3);
    expect(part(monthly, "0.zone").apply().on[0].schedule.zone).toBe(localZone());
  });

  it("says a source, a folder, a branch and another routine, each with its own editor", () => {
    const routines = [{ id: "rt-a", name: "Morning Paper" }];
    const parts = whenParts({ on: [
      { source: "github.pulls", scope: { repo: "acme/game" }, events: ["opened"], x: 1 },
      { folder: { path: "~/Inbox", events: ["added"], y: 2 } },
      { git: { repo: "/src/game", branch: "main" } },
      { after: { routine: "rt-a", outcome: "done" } },
    ] }, { routines });
    expect(words(parts.filter((p) => p.editor !== "act"))).toBe(
      "github.pulls: opened in acme/game or A file is added in ~/Inbox named anything or New commits on main in /src/game or After Morning Paper finishes ",
    );
    expect(part(parts, "0.events").apply("opened, closed").on[0]).toEqual({ source: "github.pulls", scope: { repo: "acme/game" }, events: ["opened", "closed"], x: 1 });
    expect(part(parts, "0.scope.repo").apply("acme/web").on[0].scope).toEqual({ repo: "acme/web" });
    const names = part(parts, "1.folder.names");
    expect(names.editor).toBe("glob");
    expect(names.apply("*.pdf").on[1]).toEqual({ folder: { path: "~/Inbox", events: ["added"], y: 2, names: "*.pdf" } });
    expect(part(parts, "2.git.branch").apply("dev").on[2].git).toEqual({ repo: "/src/game", branch: "dev" });
    expect(part(parts, "3.after.routine").options).toEqual([{ value: "rt-a", label: "Morning Paper" }]);
    expect(part(parts, "3.after.outcome").apply("any").on[3].after.outcome).toBe("any");
  });

  it("adds a schedule on the Mac's zone and removes a trigger", () => {
    expect(words(whenParts({ on: [] }).filter((p) => p.editor !== "act"))).toBe("When you run it ");
    const added = part(whenParts(when), "add").apply();
    expect(added.on[1]).toEqual({ schedule: { daily: "09:00", days: "weekdays", zone: localZone() } });
    expect(added.unknown).toBe("kept");
    expect(part(whenParts(when), "0.remove").apply()).toEqual({ ...when, on: [] });
  });
});

describe("the Which slot", () => {
  const which = {
    rule: { all: [{ fact: "draft", is: false }, { any: [{ fact: "paths", glob: "docs/**" }, { not: { fact: "size", gte: 100 } }] }, { fact: "author", in: ["ana", "bo"] }] },
    ask: "Worth a run?",
    later: true,
  };

  it("says the rules and the question, each value with its editor", () => {
    const parts = whichParts(which);
    expect(words(parts)).toBe("Items where draft is no and paths matches docs/** or not (size is at least 100) and author is one of ana, bo, then it asks: Worth a run?");
    expect(part(parts, "rule.0").editor).toBe("menu");
    expect(part(parts, "rule.1.0").editor).toBe("glob");
    expect(part(parts, "rule.1.1.not").check("x")).toBe("A number");
  });

  it("changes a value deep in the rule and the question, keeping the rest", () => {
    const parts = whichParts(which);
    expect(part(parts, "rule.0").apply("true").rule.all[0]).toEqual({ fact: "draft", is: true });
    const glob = part(parts, "rule.1.0").apply("guides/**");
    expect(glob.rule.all[1].any[0]).toEqual({ fact: "paths", glob: "guides/**" });
    expect(glob.rule.all[2]).toBe(which.rule.all[2]);
    expect(glob.later).toBe(true);
    expect(part(parts, "rule.1.1.not").apply("50").rule.all[1].any[1]).toEqual({ not: { fact: "size", gte: 50 } });
    expect(part(parts, "rule.2").apply("cy, di").rule.all[2].in).toEqual(["cy", "di"]);
    expect(part(parts, "ask").apply("")).toEqual({ rule: which.rule, later: true });
  });

  it("takes every item without a rule, and offers a question", () => {
    const parts = whichParts({});
    expect(words(parts.filter((p) => !p.optional))).toBe("Every item ");
    expect(part(parts, "ask").apply("Is it new?")).toEqual({ ask: "Is it new?" });
  });
});

describe("the Who, How and Goes-to slots", () => {
  it("opens an agent's brief and model from its chip", () => {
    const who = { depth: "team", agents: [{ key: "a", name: "Editor", model: "sonnet", brief: "Edit.", effort: "high", z: 1 }, { key: "b", name: "Reader", model: "haiku" }], checker: { model: "sonnet" } };
    const [editor, reader] = whoParts(who);
    expect(editor).toMatchObject({ editor: "agent", chip: true, text: "Editor", sub: "sonnet", value: { brief: "Edit.", model: "sonnet" } });
    expect(reader.options.map((o) => o.label)).toEqual(["Haiku", "Sonnet", "Opus"]);
    const next = editor.apply({ brief: "Edit hard.", model: "opus" });
    expect(next.agents[0]).toEqual({ key: "a", name: "Editor", model: "opus", brief: "Edit hard.", effort: "high", z: 1 });
    expect(next.checker).toBe(who.checker);
    expect(words(whoParts({ depth: "script", script: {} }))).toBe("A script");
  });

  it("changes a step, adds and changes a check, and drops an emptied one", () => {
    const how = { steps: ["Read", "Write"], checks: [{ key: "check-2", text: "Cites lines" }], format: "review", checkAgent: true };
    const parts = howParts(how);
    expect(words(parts)).toBe("Read · Write|Cites linesAdd a check|review");
    expect(part(parts, "step.1").apply("Draft").steps).toEqual(["Read", "Draft"]);
    expect(part(parts, "step.0").apply("").steps).toEqual(["Write"]);
    const added = part(parts, "check.add").apply("Polite");
    expect(added.checks).toEqual([{ key: "check-2", text: "Cites lines" }, { key: "check-3", text: "Polite" }]);
    expect(part(parts, "check.check-2").apply("").checks).toEqual([]);
    expect(part(parts, "format").apply("mail")).toEqual({ ...how, format: "mail" });
  });

  it("shows recipients locked, removes one added by hand, and adds one through Eos's dialog", () => {
    const goesTo = [{ id: "pr", kind: "item_place", channel: "github", bound: { fact: "repo" } }, { id: "to-2", kind: "fixed", channel: "mail", address: "ana@example.com" }];
    const parts = goesToParts(goesTo);
    expect(part(parts, "to.pr")).toMatchObject({ locked: true, text: "Where the item came from, on GitHub" });
    expect(part(parts, "to.to-2")).toMatchObject({ locked: true, text: "ana@example.com, by mail" });
    expect(part(parts, "to.pr.remove")).toBeUndefined();
    expect(part(parts, "to.to-2.remove").apply()).toEqual([goesTo[0]]);
    const add = part(parts, "to.add");
    expect(add.editor).toBe("recipient");
    expect(add.apply({ channel: "mail", address: "bo@example.com" })).toEqual([...goesTo, { id: "to-3", kind: "fixed", channel: "mail", address: "bo@example.com" }]);
  });

  it("changes what a run takes and what it makes, keeping their other keys", () => {
    const bp = { takes: { kind: "mail", label: "mail", many: false }, makes: { kind: "text", description: "Replies", contract: {} } };
    expect(part(slot("takes").parts(bp), "label").apply("message")).toEqual({ kind: "mail", label: "message", many: false });
    expect(part(slot("makes").parts(bp), "description").apply("Short replies")).toEqual({ kind: "text", description: "Short replies", contract: {} });
  });

  it("names the slots that differ and says a slot as plain text", () => {
    expect(changedSlots({ who: { a: 1 }, freedom: { rung: "draft" } }, { who: { a: 2 }, freedom: { rung: "draft" } })).toEqual(["who"]);
    expect(slotText(slot("how"), { how: { steps: ["Read"], checks: [], format: "" } })).toBe("Read · Any format");
  });
});

describe("Freedom", () => {
  const pr = { name: "PR Review", makes: { kind: "github.review" }, goesTo: [{ id: "pr", kind: "item_place", channel: "github" }], freedom: { rung: "draft", grants: [{ id: "docs" }] } };

  it("asks in Eos's own words before a routine that speaks for the user goes out on its own", () => {
    expect(freedomQuestion(pr, "send_then_tell")).toBe("PR Review will post reviews as you without asking. Allow?");
    expect(freedomQuestion(pr, "on_its_own")).toBe("PR Review will post reviews as you without asking. Allow?");
    expect(freedomQuestion(pr, "ask")).toBeNull();
    expect(freedomQuestion({ ...pr, goesTo: [{ id: "me", kind: "me", channel: "notify" }] }, "on_its_own")).toBeNull();
    expect(freedomQuestion({ ...pr, freedom: { rung: "send_then_tell" } }, "on_its_own")).toBe("PR Review will post reviews as you without asking. Allow?");
    expect(freedomQuestion({ ...pr, freedom: { rung: "on_its_own" } }, "send_then_tell")).toBeNull();
  });

  it("keeps the grants when the rung changes", () => {
    expect(withRung(pr.freedom, "ask")).toEqual({ rung: "ask", grants: [{ id: "docs" }] });
  });
});
