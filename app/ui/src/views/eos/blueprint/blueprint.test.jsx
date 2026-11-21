import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import {
  _resetBlueprints, createRoutine, discardDraft, loadDraft, loadVersion, loadVersions, makeRoutine, runTrial,
  saveBlueprint, sayToArchitect, startRoutine,
} from "../../../state/eos/blueprintStore.js";
import { _resetRoutines, loadRoutine, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { _resetRuns, loadRuns } from "../../../state/eos/runsStore.js";
import { _resetInbox } from "../../../state/eos/inboxStore.js";
import { applyEosEvent } from "../../../state/eos/live.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { BlueprintCard } from "./BlueprintCard.jsx";
import { FreedomLadder } from "./FreedomLadder.jsx";
import { shownVersion } from "./BlueprintEditor.jsx";
import { HAND_BLUEPRINT } from "./words.js";
import { useWorkerEvents } from "../../../hooks/useWorkerEvents.js";
import { SAMPLE_READS } from "../gallery/EosGallery.jsx";
import routines from "../gallery/sample/routines.json";
import routineDetail from "../gallery/sample/routine-detail.json";
import routinePaused from "../gallery/sample/routine-paused.json";
import routineDraft from "../gallery/sample/routine-draft.json";
import drafts from "../gallery/sample/blueprint-drafts.json";

vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
// The architect sessions' event rows, by worker id.
const architectEvents = {};
vi.mock("../../../hooks/useWorkerEvents.js", () => ({
  useWorkerEvents: vi.fn((id) => ({ events: architectEvents[id] ?? [], eventsFor: id })),
}));
vi.mock("../../../api/client.js", () => ({ api: { setStreamFocus: async () => ({ ok: true, body: { live: [] } }) } }));

const PR = routineDetail.routine.id;
const MAIL = routinePaused.routine.id;
const DOCS = routineDraft.routine.id;
const reads = { ...SAMPLE_READS, [ROUTES.routines]: [...routines, routineDraft.routine] };

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function recording(sent = async () => ({ ok: true, status: 200, body: {} }), paths = reads) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

// The Blueprint tab of routine `id` with its draft, versions and the
// blueprint it shows read in.
async function editor(id, transport = fixtureTransport(reads)) {
  setEosTransport(transport);
  await refreshRoutines();
  await loadRoutine(id);
  await loadDraft(id);
  await loadVersions(id);
  for (const vid of Object.values(drafts).map((d) => d.draftVersionId)) await loadVersion(id, vid);
  openLocation(`eos:/routines/${id}?tab=blueprint`);
  return renderToStaticMarkup(<EosMain />);
}

const draw = () => renderToStaticMarkup(<EosMain />);
const rowLabels = (html) => [...html.matchAll(/<dt class="eos-bp-row__label">([^<]*)/g)].map((m) => m[1]);
const changedRows = (html) => [...html.matchAll(/eos-bp-row eos-bp-row--changed"><dt class="eos-bp-row__label">([^<]*)/g)].map((m) => m[1]);
const buttonsIn = (html, cls) => [...(html.match(new RegExp(`<div class="${cls}">(.*?)</div>`))?.[1] ?? "").matchAll(/<button[^>]*>([^<]*)/g)].map((m) => m[1]);

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetRoutines();
  _resetRuns();
  _resetInbox();
  _resetBlueprints();
  _resetEosNav();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("a new routine", () => {
  it("opens on an empty conversation and the card in outline, with Fill it by hand", () => {
    setEosTransport(fixtureTransport(reads));
    openLocation("eos:/routines/new");
    const html = draw();
    expect(html).toContain('<h1 class="eos-title">New routine</h1>');
    expect(html).toContain('placeholder="Describe what Eos should take care of"');
    expect(html).not.toContain("eos-bp-bubble");
    expect(html).toContain("eos-bp-card--outline");
    expect(rowLabels(html)).toEqual(["Takes", "When", "Which", "Who", "How", "Makes", "Goes to", "Freedom"]);
    expect(html.match(/Not set yet/g)).toHaveLength(8);
    expect(html).toContain(">Fill it by hand</button>");
  });

  it("is made from what the user describes, and says plainly when three architects are at work", async () => {
    const made = { row: { ...routineDraft.routine, id: "rt-new000000001" }, versionId: "rv-new000000001", warnings: [] };
    const t = recording(async () => ({ ok: true, status: 201, body: made }));
    setEosTransport(t);
    expect(await makeRoutine("Sort my mail")).toBe("rt-new000000001");
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.routinesArchitect, { sentence: "Sort my mail" });

    const busy = { error: "too many architects are at work; finish or leave one first", code: "architects_busy" };
    setEosTransport(recording(async () => ({ ok: false, status: 409, body: busy })));
    await refreshRoutines();
    expect(await makeRoutine("Watch the build")).toBeNull();
    openLocation("eos:/routines/new");
    const html = draw();
    expect(html).toContain('<div class="eos-band eos-band--warn" role="alert"><span class="eos-band__text">Three architects are at work. Leave a draft to make room.</span>');
    expect(html).toContain(">Leave the draft of Docs Review</button>");
  });

  it("says an architect's other refusals as a line of their own, offering no draft to leave", async () => {
    const cases = [
      [{ error: "the draft has no architect", code: "no_architect" }, "No architect works on this draft now."],
      [{ error: "the routine was made by a newer Eos", code: "newer_format" }, "A newer version of Eos made this routine. It cannot be changed here."],
      [{ error: "the routine is being deleted" }, "the routine is being deleted"],
    ];
    for (const [body, line] of cases) {
      await editor(DOCS);
      setEosTransport(recording(async () => ({ ok: false, status: 409, body }), reads));
      expect(await sayToArchitect(DOCS, { text: "Skip the changelog" })).toBe(false);
      const html = draw();
      expect(html).toContain(`<p class="eos-note" role="alert">${line}</p>`);
      expect(html).not.toContain("Leave the draft of");
      expect(html).not.toContain("eos-band--err");
    }
  });

  it("is made by hand from the filled blueprint, and shows what the rules refused", async () => {
    const html = renderToStaticMarkup(<BlueprintCard blueprint={HAND_BLUEPRINT} onEdit={() => {}} />);
    expect(html).toContain('<button type="button" class="eos-bp-value" aria-haspopup="dialog" aria-expanded="false">New routine</button>');
    expect(html).toContain('role="radiogroup" aria-label="How much Eos may do on its own"');

    const t = recording(async () => ({ ok: true, status: 201, body: { row: { ...routineDraft.routine, id: "rt-hand00000001" }, versionId: "rv-x", warnings: [] } }));
    setEosTransport(t);
    expect(await createRoutine(HAND_BLUEPRINT)).toBe("rt-hand00000001");
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.routines, { blueprint: HAND_BLUEPRINT });

    const issues = [{ path: ["summary"], message: "must not be empty", severity: "error" }];
    setEosTransport(recording(async () => ({ ok: false, status: 400, body: { error: "the blueprint does not meet its rules", issues } })));
    expect(await createRoutine(HAND_BLUEPRINT)).toBeNull();
    openLocation("eos:/routines/new");
    expect(draw()).toContain("<li>summary: must not be empty</li>");
  });
});

describe("a routine being made", () => {
  it("made by hand, reads its trial cards from its runs and offers to run the trial again", async () => {
    const { [ROUTES.routineDraft(DOCS)]: _draft, ...withoutDraft } = reads;
    const trial = {
      id: "rn-trial0000001", routineId: DOCS, kind: "trial", origin: "trial", state: "done", headline: "One review drafted",
      itemTitle: "Fix the docs links", needsUser: false, costUsd: 0.2, workMs: 60000, createdAt: 1763452800000,
    };
    const hand = { ...trial, id: "rn-hand00000001", kind: "standing", origin: "hand", itemTitle: "Not a trial" };
    const paths = { ...withoutDraft, [`${ROUTES.runs}?routineId=${DOCS}&limit=50`]: { runs: [trial, hand] } };
    setEosTransport(fixtureTransport(paths));
    await loadRuns(DOCS);
    const html = await editor(DOCS, fixtureTransport(paths));
    expect(buttonsIn(html, "eos-bp-actions")).toEqual(["Start it", "Start without a trial", "Run the trial again"]);
    expect(html).toContain('<span class="eos-bp-trial__item">Fix the docs links</span><span class="eos-bp-trial__line">One review drafted</span>');
    expect(html).not.toContain("Not a trial");
  });

  it("shows the architect asking: the user's words, its question with its choices, and the card to start", async () => {
    const html = await editor(DOCS);
    expect(html).toContain('<div class="eos-bp-bubble">Review every pull request that touches the docs. Show me first.</div>');
    expect(html).toContain("Wrote the blueprint");
    expect(html).toContain('<div class="eos-bp-question__text"><md>Should it review **draft** pull requests too?</md></div>');
    expect(html).toContain('<button type="button" class="eos-btn">Only when ready</button><button type="button" class="eos-btn">Drafts too</button>');
    expect(html).toContain('placeholder="Change anything by saying it"');
    expect(html).toContain('aria-haspopup="menu" aria-expanded="false">Version 1, not running yet ▾</button>');
    expect(buttonsIn(html, "eos-bp-actions")).toEqual(["Start it", "Start without a trial", "Run a trial"]);
    expect(html).toContain('<span class="eos-bp-actions__cost">Uses github. At most $2 a run, stops at $5 a day.</span>');
    expect(html).toContain('<button type="button" class="eos-bp-chip eos-bp-value" aria-haspopup="dialog" aria-expanded="false">Editor<span class="eos-bp-chip__sub">sonnet</span></button>');
    expect(html).toContain("Where the item came from, on GitHub<span class=\"eos-sr\">, locked</span>");
  });

  it("shows what the architect itself writes, from its session's events, and not Eos's prompt to it", async () => {
    const said = (id, role, blocks) => ({ id, type: "agent_event", ts: id, payload: { type: "message", role, blocks } });
    architectEvents["wk-arch1"] = [
      { id: 1, type: "user_message", ts: 1, payload: { text: "You are the architect of a routine." } },
      said(2, "assistant", [{ type: "text", text: "I read the **docs** folder.", blockId: "b1" }]),
      said(3, "assistant", [{ type: "tool_call", callId: "c1", name: "Read", input: {} }]),
      said(4, "assistant", [{ type: "text", text: "One question first.", blockId: "b2" }]),
    ];
    const paths = { ...reads, [ROUTES.routineDraft(DOCS)]: { ...drafts[DOCS], architectId: "wk-arch1" } };
    const html = await editor(DOCS, fixtureTransport(paths));
    expect(useWorkerEvents).toHaveBeenCalledWith("wk-arch1");
    expect(html).toContain('<div class="eos-bp-reply"><md>I read the **docs** folder.</md></div><div class="eos-bp-reply"><md>One question first.</md></div>');
    expect(html).not.toContain("You are the architect");
    expect(html).toContain('<div class="eos-bp-question__text">');
    expect(html).toContain("Wrote the blueprint");
  });

  it("reads no session while no architect works on the draft", async () => {
    useWorkerEvents.mockClear();
    const html = await editor(DOCS);
    expect(useWorkerEvents).not.toHaveBeenCalled();
    expect(html).not.toContain("eos-bp-reply");
  });

  it("posts a choice to the architect, and words to it while it works", async () => {
    const t = recording(async () => ({ ok: true, status: 200, body: { ...drafts[DOCS], status: "working", question: undefined } }));
    await editor(DOCS, t);
    await sayToArchitect(DOCS, { choice: "Drafts too" });
    expect(t.send).toHaveBeenLastCalledWith("POST", ROUTES.routineDraftMessage(DOCS), { choice: "Drafts too" });
    await sayToArchitect(DOCS, { text: "Skip the changelog" });
    expect(t.send).toHaveBeenLastCalledWith("POST", ROUTES.routineDraftMessage(DOCS), { text: "Skip the changelog" });
    const html = draw();
    expect(html).toContain('<div class="eos-bp-bubble">Drafts too</div><div class="eos-bp-bubble">Skip the changelog</div>');
    expect(html).toContain('<p class="eos-note" role="status">Working on the blueprint…</p>');
  });

  it("starts, starts without a trial, and runs the trial again", async () => {
    const t = recording(async (method, path) => (path === ROUTES.routineTrial(DOCS)
      ? { ok: true, status: 201, body: { runs: [] } }
      : { ok: false, status: 409, body: { error: "Version 1 has not been tried. Try it first, or start it without a trial.", code: "trial_needed", version: 1 } }));
    await editor(DOCS, t);
    expect(await startRoutine(DOCS)).toBe(false);
    expect(t.send).toHaveBeenLastCalledWith("POST", ROUTES.routineStart(DOCS), { withoutTrial: false });
    expect(draw()).toContain('<span class="eos-band__text">Version 1 has not been tried. Try it first, or start it without a trial.</span>');

    expect(await runTrial(DOCS)).toBe(true);
    expect(t.send).toHaveBeenLastCalledWith("POST", ROUTES.routineTrial(DOCS), {});

    const started = { ...routineDraft.routine, state: "active" };
    t.send.mockImplementation(async () => ({ ok: true, status: 200, body: started }));
    expect(await startRoutine(DOCS, true)).toBe(true);
    expect(t.send).toHaveBeenLastCalledWith("POST", ROUTES.routineStart(DOCS), { withoutTrial: true });
    expect(draw()).not.toContain("Try it first");
  });

  it("says which version was tried and puts trying the shown one again first when an edit came after the trial", async () => {
    const [first] = SAMPLE_READS[ROUTES.routineVersions(DOCS)];
    const edited = { ...first, id: "rv-edited000001", number: 2, author: "user" };
    const trial = {
      id: "rn-trial0000001", routineId: DOCS, kind: "trial", origin: "trial", state: "done", headline: "One review drafted",
      itemTitle: "Fix the docs links", needsUser: false, costUsd: 0.2, workMs: 60000, createdAt: 1763452800000,
    };
    const paths = {
      ...reads,
      [ROUTES.routineVersions(DOCS)]: [first, edited],
      [ROUTES.routineVersion(DOCS, edited.id)]: { ...reads[ROUTES.routineVersion(DOCS, first.id)], ...edited },
      [ROUTES.routineDraft(DOCS)]: { ...drafts[DOCS], trialRuns: [trial] },
    };
    const t = recording(async () => ({ ok: false, status: 409, body: { error: "acme/docs is not a project in Eos. Add your local clone of it as a project, then start again.", code: "no_local_clone", repo: "acme/docs" } }), paths);
    await editor(DOCS, t);
    await loadVersion(DOCS, edited.id);
    const html = draw();
    expect(html).toContain('<p class="eos-note" role="status">Version 2 has not been tried. The trial ran on version 1.</p>');
    expect(buttonsIn(html, "eos-bp-actions")).toEqual(["Run the trial again", "Start without a trial"]);
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Run the trial again</button>');

    expect(await runTrial(DOCS)).toBe(false);
    expect(draw()).toContain('<span class="eos-band__text">acme/docs is not a project in Eos. Add your local clone of it as a project, then start again.</span>');
  });

  it("asks for a change of a routine without a draft, which brings its architect back", async () => {
    const t = recording(async () => ({ ok: true, status: 200, body: { ...drafts[MAIL], status: "working" } }));
    await editor(PR, t);
    await sayToArchitect(PR, { text: "Only review the docs" });
    expect(t.send).toHaveBeenLastCalledWith("POST", ROUTES.routineChange(PR), { text: "Only review the docs" });
  });

  it("talks to the architect of a routine still being made after its draft was left, never asking for a change", async () => {
    const left = { ...drafts[DOCS], status: "abandoned", question: undefined, choices: [] };
    const t = recording(async () => ({ ok: true, status: 200, body: { ...left, status: "working" } }), { ...reads, [ROUTES.routineDraft(DOCS)]: left });
    await editor(DOCS, t);
    await sayToArchitect(DOCS, { text: "Start again, drafts too" });
    expect(t.send).toHaveBeenLastCalledWith("POST", ROUTES.routineDraftMessage(DOCS), { text: "Start again, drafts too" });
  });

  it("offers no talk for a routine made by hand that has not run, which has no architect", async () => {
    const withoutDraft = { ...reads };
    delete withoutDraft[ROUTES.routineDraft(DOCS)];
    const html = await editor(DOCS, fixtureTransport(withoutDraft));
    expect(html).toContain("This routine was made by hand.");
    expect(html).not.toContain('placeholder="Change anything by saying it"');
  });
});

describe("live", () => {
  it("reads the draft and versions again on routine:change, and the draft on a trial's run:change", async () => {
    const t = recording();
    await editor(DOCS, t);
    t.get.mockClear();
    applyEosEvent("routine:change", { routineId: DOCS, reason: "draft" });
    expect(t.get.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([ROUTES.routineDraft(DOCS), ROUTES.routineVersions(DOCS)]));
    t.get.mockClear();
    applyEosEvent("run:change", { runId: "rn-trial", routineId: DOCS, state: "done" });
    expect(t.get.mock.calls.map((c) => c[0])).toContain(ROUTES.routineDraft(DOCS));
  });
});

describe("an architect's change of a running routine", () => {
  it("shows the draft version read-only with its changed slots, Use this version and Discard, and the trial cards", async () => {
    const html = await editor(MAIL);
    expect(html).toContain('aria-haspopup="menu" aria-expanded="false">Version 3, not in use yet ▾</button>');
    expect(html).not.toContain("Add a recipient");
    expect(changedRows(html)).toEqual(["Who"]);
    expect(html).not.toContain('class="eos-bp-value"');
    expect(buttonsIn(html, "eos-bp-actions")).toEqual(["Use this version", "Discard", "Run the trial again"]);
    expect(html).toContain("Changed Who");
    expect(html).toContain("Ran a trial on 2 past items");
    expect(html).toContain('<h2 class="eos-label">Trial on 2 past items, nothing was sent</h2>');
    expect(html).toContain('<span class="eos-bp-trial__item">Invoice from Acme</span><span class="eos-bp-trial__line">Two replies drafted</span><button type="button" class="eos-link">Read the draft</button>');
  });

  it("uses the version through start, and discards it", async () => {
    const t = recording(async (method) => ({ ok: true, status: 200, body: method === "DELETE" ? { ...drafts[MAIL], status: "abandoned" } : routinePaused.routine }));
    await editor(MAIL, t);
    await startRoutine(MAIL);
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.routineStart(MAIL), { withoutTrial: false });
    await discardDraft(MAIL);
    expect(t.send).toHaveBeenLastCalledWith("DELETE", ROUTES.routineDraft(MAIL), undefined);
    expect(draw()).toContain("You left this draft.");
  });
});

describe("a hand edit", () => {
  it("keeps a new version from the version shown", async () => {
    const saved = { row: routineDetail.routine, versionId: "rv-new", warnings: [] };
    const t = recording(async () => ({ ok: true, status: 200, body: saved }));
    const html = await editor(PR, t);
    expect(html).toContain('class="eos-bp-value"');
    const view = shownVersion(routineDetail, null, null);
    expect(view).toEqual({ kind: "head", versionId: routineDetail.head.id });
    const next = { ...routineDetail.head.blueprint, makes: { description: "A review" } };
    expect(await saveBlueprint(PR, view.versionId, next)).toBe(true);
    expect(t.send).toHaveBeenCalledWith("PUT", ROUTES.routineBlueprint(PR), { baseVersionId: routineDetail.head.id, blueprint: next });
  });

  it("reads the routine again and says it changed elsewhere when its base is stale", async () => {
    const t = recording(async () => ({ ok: false, status: 409, body: { error: "the routine changed since this edit began" } }));
    await editor(PR, t);
    t.get.mockClear();
    expect(await saveBlueprint(PR, "rv-old", {})).toBe(false);
    expect(t.get.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([ROUTES.routine(PR), ROUTES.routineVersions(PR), ROUTES.routineDraft(PR)]));
    expect(draw()).toContain('<span class="eos-band__text">Changed elsewhere. This is the routine as it is now.</span>');
  });

  it("shows what the rules refused", async () => {
    const issues = [{ path: ["limits", "parallel"], message: "at most 3", severity: "error" }];
    await editor(PR, recording(async () => ({ ok: false, status: 400, body: { error: "the blueprint does not meet its rules", issues } })));
    await saveBlueprint(PR, routineDetail.head.id, {});
    expect(draw()).toContain("<li>limits › parallel: at most 3</li>");
  });

  it("is not offered on a blueprint a newer Eos made", async () => {
    const newer = { ...routinePaused, head: { ...routinePaused.head, format: 2, runnable: false } };
    const noDraft = Object.fromEntries(Object.entries(reads).filter(([path]) => path !== ROUTES.routineDraft(MAIL)));
    const html = await editor(MAIL, fixtureTransport({ ...noDraft, [ROUTES.routine(MAIL)]: newer }));
    expect(html).toContain("A newer version of Eos made this blueprint. It can be read here, not changed or run.");
    expect(html).not.toContain('class="eos-bp-value"');
    expect(html).not.toContain("eos-bp-actions");
  });
});

describe("the Freedom ladder", () => {
  const pr = { name: "PR Review", makes: { kind: "github.review" }, goesTo: [{ id: "pr", kind: "item_place", channel: "github" }] };
  const ladder = (rung, onApply = () => {}) => renderToStaticMarkup(<FreedomLadder blueprint={{ ...pr, freedom: { rung } }} onApply={onApply} />);
  const RUNG_LABELS = { ask: "Ask each time", draft: "Draft, I send", send_then_tell: "Send, then tell me", on_its_own: "On its own" };
  const rungs = (html) => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ label: m[2], attrs: m[1] }));

  it("offers every rung, the one set checked", () => {
    for (const rung of ["ask", "draft", "send_then_tell", "on_its_own"]) {
      const all = rungs(ladder(rung));
      expect(all.map((r) => r.label)).toEqual(["Ask each time", "Draft, I send", "Send, then tell me", "On its own"]);
      for (const r of all) expect(r.attrs).not.toContain("aria-disabled");
      expect(all.filter((r) => r.attrs.includes('aria-checked="true"')).length).toBe(1);
      expect(all.find((r) => r.attrs.includes('aria-checked="true"')).label).toBe(RUNG_LABELS[rung]);
    }
  });

  it("is read-only without a way to apply it", () => {
    const html = renderToStaticMarkup(<FreedomLadder blueprint={{ ...pr, freedom: { rung: "draft" } }} />);
    for (const r of rungs(html)) expect(r.attrs).toContain('aria-disabled="true"');
  });
});
