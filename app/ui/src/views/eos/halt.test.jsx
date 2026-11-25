import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../state/eos/transport.js";
import { _resetHalt, dismissResumed, loadHalt, resumeEos } from "../../state/eos/haltStore.js";
import { _resetInbox, answerInboxItem, loadInboxItem, refreshInbox } from "../../state/eos/inboxStore.js";
import { applyEosEvent } from "../../state/eos/live.js";
import { _resetRoutines, loadRoutine, refreshRoutines, setRoutineState } from "../../state/eos/routinesStore.js";
import { notify } from "../../lib/notify.js";
import { EosMain } from "./EosMain.jsx";
import { _resetEosNav, eosLocation, openLocation } from "./nav/eosNav.js";
import { UnconfirmedRecipients } from "./routine/Unconfirmed.jsx";
import { timeAt } from "./routine/words.js";
import routines from "./gallery/sample/routines.json";
import routinePaused from "./gallery/sample/routine-paused.json";
import inbox from "./gallery/sample/inbox.json";
import inboxItems from "./gallery/sample/inbox-items.json";

vi.mock("../../api/client.js", () => ({ api: { setStreamFocus: async () => ({ ok: true, body: { live: [] } }) } }));
vi.mock("../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
vi.mock("../../keymap/useKeymap.js", () => ({ useGlobalKeymap: () => {}, useKeybinding: () => {} }));

const MAIL = routinePaused.routine.id;
const ALERT = inboxItems.find((d) => d.item.kind === "routine_alert");
const SINCE = 1763460000000;
const STOPPED = "Eos is stopped";
const REFUSAL = {
  error: "Confirm where this routine sends before it resumes.",
  code: "recipients_unconfirmed",
  recipients: [{ id: "rc-1", label: "@sam" }, { id: "rc-2", label: "billing@acme.io" }],
};
const reads = {
  [ROUTES.routines]: routines,
  [ROUTES.inbox]: inbox,
  [ROUTES.routine(MAIL)]: routinePaused,
  [ROUTES.inboxItem(ALERT.item.id)]: ALERT,
  [ROUTES.eosHalt]: { on: false },
};

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function recording(sent, paths = reads) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

async function at(location, transport) {
  setEosTransport(transport);
  await refreshRoutines();
  await refreshInbox();
  await loadRoutine(MAIL);
  await loadInboxItem(ALERT.item.id);
  openLocation(location);
  return renderToStaticMarkup(<EosMain />);
}

const draw = () => renderToStaticMarkup(<EosMain />);
const LISTED = '<ul class="eos-recipients" aria-label="Recipients to confirm"><li>@sam</li><li>billing@acme.io</li></ul>';
const RECIPIENTS = '<ul class="eos-recipients" aria-label="Recipients to confirm"><li>@sam</li><li>billing@acme.io</li></ul><button type="button" class="eos-btn eos-btn--primary">Review the change</button>';

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetRoutines();
  _resetInbox();
  _resetHalt();
  _resetEosNav();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("the Eos is stopped band", () => {
  it("shows across Eos mode on inbox:halt {on: true}, and Resume clears it and says where the stopped sends wait", async () => {
    const t = recording(async () => ({ ok: true, status: 200, body: { on: false } }));
    let html = await at("eos:/needs", t);
    expect(html).not.toContain(STOPPED);

    applyEosEvent("inbox:halt", { on: true, since: SINCE });
    html = draw();
    expect(html).toContain('</header><div class="eos-halt eos-halt--stopped" role="status">');
    expect(html).toContain(`<strong>Eos is stopped since ${timeAt(SINCE)}.</strong> No routine runs and nothing is sent until you resume.</p><button type="button" class="eos-btn eos-btn--primary">Resume</button></div>`);
    openLocation(`eos:/routines/${MAIL}`);
    expect(draw()).toContain(STOPPED);

    expect(await resumeEos()).toBe(true);
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.eosResume, {});
    html = draw();
    expect(html).not.toContain(STOPPED);
    expect(html).toContain("<strong>Eos runs again.</strong> Sends that were stopped wait in Needs you.");
    dismissResumed();
    expect(draw()).not.toContain("Eos runs again");
  });

  it("reads the switch from the core, and goes when another device resumes", async () => {
    await at("eos:/needs", fixtureTransport({ ...reads, [ROUTES.eosHalt]: { on: true, since: SINCE } }));
    await loadHalt();
    expect(draw()).toContain(STOPPED);
    applyEosEvent("inbox:halt", { on: false });
    const html = draw();
    expect(html).not.toContain(STOPPED);
    expect(html).not.toContain("Eos runs again");
  });

  it("stays when the core refuses Resume, with a toast", async () => {
    const toast = vi.spyOn(notify, "error").mockImplementation(() => {});
    await at("eos:/needs", recording(async () => ({ ok: false, status: 403, body: { error: "not allowed" } })));
    applyEosEvent("inbox:halt", { on: true });
    expect(await resumeEos()).toBe(false);
    expect(toast).toHaveBeenCalledWith("not allowed", { title: "Eos" });
    expect(draw()).toContain("Eos is stopped.</strong> No routine runs");
    toast.mockRestore();
  });
});

describe("a Resume refused until recipients are confirmed", () => {
  it("says in the lead that it waits for recipients, with the core's text, the recipients, Review the change and Resume under", async () => {
    const toast = vi.spyOn(notify, "error").mockImplementation(() => {});
    const t = recording(async () => ({ ok: false, status: 409, body: REFUSAL }));
    await at(`eos:/routines/${MAIL}`, t);
    expect(await setRoutineState(MAIL, "active")).toBe(false);
    expect(t.send).toHaveBeenCalledWith("PUT", ROUTES.routineState(MAIL), { state: "active" });
    expect(toast).not.toHaveBeenCalled();
    const html = draw();
    expect(html).toContain('<p class="eos-rlead__now eos-rlead__now--warn" role="status">Paused until you confirm who it sends to.</p>');
    expect(html).toContain(`<div class="eos-refusal" role="alert"><span class="eos-band__text">${REFUSAL.error}</span>${LISTED}</div><div class="eos-rlead__acts"><button type="button" class="eos-btn eos-btn--primary">Review the change</button><button type="button" class="eos-btn">Resume</button>`);
    expect(html).not.toContain("Paused after three failed runs in a row.");

    applyEosEvent("routine:change", { routineId: MAIL, reason: "state", row: { ...routinePaused.routine, state: "active", pausedReason: undefined } });
    expect(draw()).not.toContain("Recipients to confirm");
    toast.mockRestore();
  });

  it("shows them on the routine's alert card when its Resume answers 409", async () => {
    const toast = vi.spyOn(notify, "error").mockImplementation(() => {});
    const t = recording(async () => ({ ok: false, status: 409, body: REFUSAL }));
    await at(`eos:/needs/${ALERT.item.id}`, t);
    expect(await answerInboxItem(ALERT.item.id, { kind: "routine_alert", choice: "resume" })).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(draw()).toContain(`<div class="eos-refusal" role="alert"><span class="eos-band__text">${REFUSAL.error}</span>${RECIPIENTS}</div>`);
    toast.mockRestore();
  });

  it("Review the change opens the routine's blueprint", () => {
    const button = UnconfirmedRecipients({ refusal: REFUSAL, routineId: MAIL }).props.children[2];
    button.props.onClick();
    expect(eosLocation()).toBe(`eos:/routines/${MAIL}?tab=blueprint`);
  });
});
