import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import {
  _resetNotes, applyMemoryChange, editNote, forgetNote, loadNote, loadNotes, notesPath, refreshMemorySummary, restoreNote, useNotes,
} from "../../../state/eos/notesStore.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { SAMPLE_READS } from "../gallery/EosGallery.jsx";
import { AboutYouSlot } from "./aboutYouSlot.js";
import memory from "../gallery/sample/memory.json";
import { loadRecalled, notRightNote } from "../../../state/eos/notesStore.js";
import { WhyPanel } from "../needs/WhyPanel.jsx";
import { RunMemory } from "../run/RunMemory.jsx";

const [summaryNote, docsNote, lintNote] = memory.notes.notes;

async function loaded() {
  await Promise.all([refreshRoutines(), refreshMemorySummary(), loadNotes(notesPath())]);
}

function at(location, aboutYou = null) {
  openLocation(location);
  return renderToStaticMarkup(<AboutYouSlot.Provider value={aboutYou}><EosMain /></AboutYouSlot.Provider>);
}

function storeNow() {
  let seen;
  function Probe() {
    seen = useNotes();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return seen;
}

beforeEach(() => {
  _resetNotes();
  _resetRoutines();
  _resetEosNav();
  setEosTransport(fixtureTransport(SAMPLE_READS));
});
afterEach(() => setEosTransport(null));

describe("Eos › Memory › Learned from work", () => {
  it("shows the weekly line, both tabs with their counts, and the filters by place and kind", async () => {
    await loaded();
    const html = at("eos:/memory");
    expect(html).toContain('<h1 class="eos-title">Memory</h1>');
    expect(html).toContain("Eos learned 3 things this week, without asking.");
    expect(html).toContain('aria-selected="false" class="eos-tab">About you<span class="eos-mem-tab-count">12</span>');
    expect(html).toContain('aria-selected="true" class="eos-tab">Learned from work<span class="eos-mem-tab-count">6</span>');
    const chips = [...html.matchAll(/class="eos-chip eos-mem-filter" aria-pressed="(true|false)">([^<]+)</g)].map((m) => `${m[2]}${m[1] === "true" ? "*" : ""}`);
    expect(chips).toEqual(["Everything*", "game-client", "PR Review", "Lessons", "Facts", "Skills", "Good examples"]);
  });

  it("groups notes by where they hold, a routine by its name and everywhere last, each row with why, who taught it and its strength", async () => {
    await loaded();
    const html = at("eos:/memory?tab=work");
    const groups = [...html.matchAll(/eos-mem-group__name">([^<]+)<\/h2><span class="eos-mem-group__count">(\d+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(groups).toEqual(["PR Review 2", "game-client 2", "Everywhere 2"]);
    expect(html).toContain(`<span class="eos-mem-row__text">${summaryNote.text}</span><span class="eos-mem-row__why">You shortened four before sending. Trying it, helped 3 times.</span>`);
    expect(html).toContain('<span class="eos-chip">You did</span><span class="eos-mem-strength" role="img" aria-label="Strength 4 of 5">');
    expect(html).toContain(`${docsNote.text}</span><span class="eos-mem-row__why">You said so. Firm, helped 5 times.</span>`);
    expect(html).toContain('<span class="eos-chip">You said</span><span class="eos-mem-strength" role="img" aria-label="Strength 5 of 5">');
    expect(html).toContain("Not used in 40 days. Cooling.");
    expect(html).toContain('aria-label="Strength 2 of 5"');
    expect(html).toContain("Text inside pull requests, mails or web pages can never write here.");
  });

  it("opens a note beside the list: what taught it, what it is about, when it comes back, whether it helped, Edit and Forget", async () => {
    await loaded();
    await loadNote(lintNote.id);
    const html = at(`eos:/memory?tab=work&note=${lintNote.id}`);
    expect(html).toContain('<button type="button" class="eos-mem-row__open" aria-current="true">');
    expect(html).toContain(`<h2 class="eos-mem-detail__text">${lintNote.text}</h2>`);
    expect(html).toMatch(/A lesson, for game-client\. Trying since [^<]+\.</);
    expect(html).toContain("A push failed, lint fixed it.");
    expect(html).toContain('<li class="eos-chip">git push</li>');
    expect(html).toContain("Next to it:");
    expect(html).toContain("An agent is about to push in game-client. It then reads:");
    expect(html).toContain(`<blockquote class="eos-mem-detail__quote">${lintNote.text}.</blockquote>`);
    expect(html).toContain("Came back 6 times, used 5 times. It helped 4 times.");
    expect(html).toContain(">Edit</button>");
    expect(html).toContain(">Forget</button>");
  });

  it("says a note is gone when the core no longer has it", async () => {
    await loaded();
    await loadNote("mn-000000000999");
    expect(at("eos:/memory?note=mn-000000000999")).toContain("This note is gone.");
  });

  it("asks a page of notes by place, kind and words", () => {
    expect(notesPath()).toBe(ROUTES.memoryNotes);
    expect(notesPath({ scope: "routine:rt-1", kind: "lesson", q: "lint" })).toBe(`${ROUTES.memoryNotes}?scope=routine%3Art-1&kind=lesson&q=lint`);
  });
});

describe("Eos › Memory › About you", () => {
  it("draws the body the app hands in, and says it shows in the app when none is", async () => {
    await loaded();
    expect(at("eos:/memory?tab=about", () => <p>today's memories</p>)).toContain("<p>today&#x27;s memories</p>");
    expect(at("eos:/memory?tab=about")).toContain("About you shows in the app.");
  });

  it("keeps the header's one search on both tabs and hands its words to the body", async () => {
    await loaded();
    const html = at("eos:/memory?tab=about", ({ query }) => <p>searching “{query}”</p>);
    expect(html).toContain('aria-label="Search memory"');
    expect(html).toContain("searching “”");
  });
});

describe("the notes store", () => {
  function core(answers) {
    const send = vi.fn(async (method, path, body) => answers(method, path, body));
    setEosTransport({ ...fixtureTransport(SAMPLE_READS), send });
    return send;
  }
  const detailOf = (row, over = {}) => ({ ...memory.details.find((d) => d.note.id === row.id), note: { ...row, ...over } });

  it("keeps an edit made on the note's rev, and reads the note again when it changed meanwhile", async () => {
    await loaded();
    const send = core((method, path, body) => (body.baseRev === 1
      ? { ok: true, status: 200, body: detailOf(lintNote, { text: body.text, rev: 2 }) }
      : { ok: false, status: 409, body: { error: "changed", rev: 3 } }));
    expect(await editNote(lintNote.id, "Lint first.", 1)).toBe(true);
    expect(send).toHaveBeenCalledWith("PUT", ROUTES.memoryNote(lintNote.id), { text: "Lint first.", baseRev: 1 });
    expect(storeNow().pages[ROUTES.memoryNotes].notes.find((n) => n.id === lintNote.id).text).toBe("Lint first.");
    expect(await editNote(lintNote.id, "Again.", 0)).toBe(false);
  });

  it("takes a forgotten note out of the lists, and puts it back when it is brought back", async () => {
    await loaded();
    core((method) => ({ ok: true, status: 200, body: detailOf(lintNote, method === "DELETE" ? { forgottenAt: 5 } : {}) }));
    await forgetNote(lintNote.id);
    expect(storeNow().pages[ROUTES.memoryNotes].notes.map((n) => n.id)).not.toContain(lintNote.id);
    expect(at(`eos:/memory?note=${lintNote.id}`)).toContain("Bring it back</button>");
    await restoreNote(lintNote.id);
    await vi.waitFor(() => expect(storeNow().pages[ROUTES.memoryNotes].notes.map((n) => n.id)).toContain(lintNote.id));
  });

  it("on memory:change reads the head, the notes it names that are open, and the pages loaded", async () => {
    await loaded();
    await loadNote(lintNote.id);
    const get = vi.fn(async () => ({ ok: false, status: 500, body: {} }));
    setEosTransport({ get, send: vi.fn() });
    applyMemoryChange({ ids: [lintNote.id, "mn-elsewhere"], action: "learned" });
    expect(get.mock.calls.map(([p]) => p).sort()).toEqual([ROUTES.memoryNote(lintNote.id), ROUTES.memoryNotes, ROUTES.memorySummary].sort());
    get.mockClear();
    applyMemoryChange({ ids: [lintNote.id], action: "counts" });
    expect(get.mock.calls.map(([p]) => p).sort()).toEqual([ROUTES.memoryNote(lintNote.id), ROUTES.memorySummary].sort());
  });

  it("reads nothing on memory:change while Memory was never opened", () => {
    const get = vi.fn();
    setEosTransport({ get, send: vi.fn() });
    applyMemoryChange({ ids: ["mn-1"], action: "learned" });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("memory in the other screens", () => {
  const runId = memory.recalled.runId;

  it("shows a draft's Why aside with each note its run was given once, and Not right", async () => {
    await loadRecalled({ runId });
    const html = renderToStaticMarkup(<WhyPanel runId={runId} />);
    expect(html).toContain("Eos remembered 4 things from your earlier corrections:");
    expect(html.match(/class="eos-needs-why__text"/g)).toHaveLength(4);
    expect(html).toContain(`${summaryNote.text}</button><span class="eos-needs-why__from">You shortened four before sending</span>`);
    expect(html.match(/>Not right<\/button>/g)).toHaveLength(4);
  });

  it("shows nothing where a run was given no note", async () => {
    await loadRecalled({ runId: "rn-none" });
    expect(renderToStaticMarkup(<WhyPanel runId="rn-none" />)).toBe("");
    expect(renderToStaticMarkup(<RunMemory runId="rn-none" />)).toBe("");
  });

  it("shows a run's first three notes and how many came with it", async () => {
    await loadRecalled({ runId });
    const html = renderToStaticMarkup(<RunMemory runId={runId} />);
    expect(html).toContain("Memory that came with it");
    expect(html.match(/class="eos-run-memory__note"/g)).toHaveLength(3);
    expect(html).toContain(">4 notes in all</button>");
  });

  it("says Not right with the run and the user's words, and the note's new strength reaches the aside", async () => {
    await loadRecalled({ runId });
    const weaker = { ...memory.details[0], note: { ...summaryNote, strength: 0.4 } };
    const send = vi.fn(async () => ({ ok: true, status: 200, body: weaker }));
    setEosTransport({ ...fixtureTransport(SAMPLE_READS), send });
    expect(await notRightNote(summaryNote.id, { runId, note: "not for docs" })).toBe(true);
    expect(send).toHaveBeenCalledWith("POST", ROUTES.memoryNoteNotRight(summaryNote.id), { note: "not for docs", runId, workerId: undefined });
    expect(storeNow().recalled[`run:${runId}`].filter((n) => n.row.id === summaryNote.id).every((n) => n.row.strength === 0.4)).toBe(true);
  });
});

describe("a playbook's version", () => {
  it("names the version a replay kept, and nothing for other notes", async () => {
    const { playbookLine } = await import("./words.js");
    const at = Date.UTC(2026, 10, 23, 12);
    const playbook = { note: { kind: "playbook" }, versions: [{ rev: 1, at, why: "rewritten" }, { rev: 2, at, why: "rewritten" }] };
    expect(playbookLine(playbook)).toMatch(/^Version 2, kept .+ after a replay on past items came closer to what you sent\.$/);
    expect(playbookLine({ note: { kind: "lesson" }, versions: [{ rev: 1, at, why: "rewritten" }] })).toBeNull();
  });
});
