import { describe, it, expect } from "vitest";
import {
  dreamProposals, dreamStatusLine, droppedTotal, fmtDreamTime, isAgentSuggestion, kindCounts, runSummary, scopeLine, supportLine, targetsOf, whyOf,
} from "./dreamProposals.js";

let seq = 0;
const mem = (over = {}) => ({
  id: `um-d${++seq}`, text: "x", category: "work-style", scope: { kind: "global" }, tier: "always",
  status: "active", source: { kind: "user" }, rev: 0, createdAt: seq, updatedAt: seq, ...over,
});
const dream = (kind, targets = [], over = {}) => mem({
  status: "suggested", source: { kind: "dream", dreamId: "dr-1", evidence: [] }, proposal: { kind, targets, confidence: 3 }, ...over,
});

describe("dreamProposals", () => {
  it("dream proposals vs agent suggestions, walked by kind", () => {
    const agent = mem({ status: "suggested", source: { kind: "agent", agentId: "w", agentName: "a" } });
    const r = dream("retire", ["um-x"]);
    const n = dream("new");
    const u = dream("update", ["um-y"]);
    expect(dreamProposals([agent, r, n, u]).map((m) => m.proposal.kind)).toEqual(["new", "update", "retire"]);
    expect(isAgentSuggestion(agent)).toBe(true);
    expect(isAgentSuggestion(n)).toBe(false);
    expect(kindCounts([r, n, u, dream("new")])).toEqual([
      { kind: "new", label: "New", count: 2 }, { kind: "update", label: "Update", count: 1 }, { kind: "retire", label: "Retire", count: 1 },
    ]);
  });

  it("targets and the scope a change lands in", () => {
    const p = mem({ id: "um-p", scope: { kind: "project", path: "/Users/me/eos" } });
    const promote = dream("promote", ["um-p"]);
    expect(targetsOf(promote, [p]).map((t) => t.id)).toEqual(["um-p"]);
    expect(scopeLine(promote, [p])).toBe("eos → All projects");
    expect(scopeLine(dream("new", [], { scope: { kind: "project", path: "/x/dear-souls" } }), [])).toBe("dear-souls");
    expect(targetsOf(dream("update", ["um-gone"]), [p])).toEqual([]);
  });

  it("times read like a person would say them", () => {
    const now = new Date(2026, 9, 4, 9, 0).getTime();
    expect(fmtDreamTime(new Date(2026, 9, 4, 3, 0).getTime(), now)).toBe("today 03:00");
    expect(fmtDreamTime(new Date(2026, 9, 5, 3, 0).getTime(), now)).toBe("tonight 03:00");
    expect(fmtDreamTime(new Date(2026, 9, 3, 2, 40).getTime(), now)).toBe("yesterday 02:40");
    expect(fmtDreamTime(new Date(2026, 8, 30, 3, 0).getTime(), now)).toBe("Sep 30 · 03:00");
  });

  it("status line and run summary", () => {
    const s = { enabled: true, schedule: "nightly", nightlyAt: "03:00", awayMinutes: 20 };
    const now = new Date(2026, 9, 4, 9, 0).getTime();
    expect(dreamStatusLine({ running: true, progress: { done: 3, total: 12, chat: "x", noticed: [] } }, s)).toBe("Dreaming… reading chat 4 of 12");
    expect(dreamStatusLine({ running: false, nextAt: new Date(2026, 9, 5, 3).getTime(), blocked: null }, s, now)).toBe("Next: tonight 03:00");
    expect(dreamStatusLine({ running: false, blocked: "sign-in" }, s)).toBe("Needs a Claude sign-in");
    expect(dreamStatusLine({ running: false, blocked: "disabled" }, { ...s, enabled: false })).toBe("Off");
    expect(runSummary({ status: "done", chatsRead: 14, proposed: 6 })).toBe("14 chats · 6 proposals");
    expect(runSummary({ status: "done", chatsRead: 1, proposed: 0, candidates: 3 })).toBe("1 chat · 0 proposals · 3 ideas gathering support");
    expect(runSummary({ status: "skipped", reason: "Nothing new since the last dream" })).toBe("Nothing new since the last dream");
    expect(droppedTotal({ dropped: { oneOff: 2, known: 1, declined: 0, secret: 1, weak: 0, invalid: 0 } })).toBe(4);
  });

  it("support and why: what backs a proposal, what goes wrong without it", () => {
    const at = (support, why) => ({ status: "suggested", source: { kind: "dream", dreamId: "dr-1", evidence: [], why }, proposal: { kind: "new", targets: [], support } });
    const base = { firstSeen: 1, lastSeen: 2 };
    expect(supportLine(at({ ...base, chats: 1, days: 1, projects: 1, origin: "explicit" }))).toBe("You said it as a standing rule");
    expect(supportLine(at({ ...base, chats: 3, days: 2, projects: 2, origin: "inferred" }))).toBe("Seen in 3 chats on 2 days · 2 projects");
    expect(supportLine({ proposal: { kind: "new", targets: [], confidence: 3 } })).toBe(null);
    expect(whyOf(at(undefined, "Agents push without asking."))).toBe("Agents push without asking.");
    expect(whyOf({ source: { kind: "agent" } })).toBe(null);
  });
});
