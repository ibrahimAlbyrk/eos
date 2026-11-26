import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetSurfaces, pressedRow, refreshSurfaces, runSurfaceAction, useSurfaces } from "../../../state/eos/surfacesStore.js";
import { UiProvider } from "../../../state/ui.jsx";
import { ConfirmBelow, factsLookup, SurfaceCard, typedRight, ViewAside, ViewSubmit } from "./SurfaceCard.jsx";

vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));

const surface = { id: "sf-5a3b1e000001", routineId: "rt-sample000004", level: "view", place: "needs_you", role: "result", title: "Morning Mail" };
const issue = { id: "si-5a3b1e000003", surfaceId: surface.id, seq: 3, kind: "view", status: "ready", rev: 1, trial: false, createdAt: 1795000000000 };
const view = {
  title: "Overnight mail", summary: "12 mails came in.",
  ui: '<Callout action="again">12 mails came in overnight.</Callout>',
  actions: { again: { label: "Run again", kind: "send", text: "again" } },
};
const reads = {
  [`${ROUTES.surfaces}?place=needs_you`]: { surfaces: [surface, { ...surface, id: "sf-page", level: "page" }] },
  [`${ROUTES.surfaceIssues(surface.id)}?limit=20`]: { issues: [{ ...issue, id: "si-trial", seq: null, trial: true }, issue], more: true },
  [ROUTES.surfaceIssue(surface.id, issue.id)]: { issue, body: { view, actions: ["again"] } },
};

function cards() {
  let read;
  function Probe() {
    read = useSurfaces();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read.cards;
}

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

beforeEach(() => {
  _resetSurfaces();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  setEosTransport(null);
  delete globalThis.localStorage;
});

describe("a routine's View in Needs you", () => {
  it("is read as the newest ready issue of each View surface placed there, past a newer trial", async () => {
    setEosTransport(fixtureTransport(reads));
    await refreshSurfaces();
    expect(cards()).toEqual([{ surface, issue, body: { view, actions: ["again"] } }]);
  });

  it("draws the View in Eos's frame, which says who made it and that it is a View", () => {
    const html = renderToStaticMarkup(
      <UiProvider><SurfaceCard card={{ surface, issue, body: { view } }} routineName="Morning Mail" /></UiProvider>,
    );
    expect(html).toContain('<section class="eos-frame" aria-label="Made by Morning Mail">');
    expect(html).toContain('<span class="eos-frame__maker">Drawn by Morning Mail. Only the buttons under it act.</span>');
    expect(html).not.toContain("eos-frame__level");
    expect(html).toContain("Overnight mail");
    expect(html).toContain("12 mails came in overnight.");
  });

  it("presses a button with the issue, the action's name and what the user typed, never arguments", async () => {
    const send = vi.fn(async () => ({ ok: true, status: 202, body: { status: "confirm", recordId: "da-1", token: "t-1", prompt: "Run Morning Mail again?" } }));
    setEosTransport({ ...fixtureTransport(reads), send });
    const answer = await runSurfaceAction({ issueId: issue.id, actionId: "again", state: { note: "short" }, clientId: "c-1" });
    expect(answer).toEqual({ status: "confirm", recordId: "da-1", token: "t-1", prompt: "Run Morning Mail again?" });
    await runSurfaceAction({ issueId: issue.id, actionId: "again", clientId: "c-1", confirm: "t-1" });
    expect(send.mock.calls).toEqual([
      ["POST", ROUTES.actionsRun, { issueId: issue.id, actionId: "again", clientId: "c-1", state: { note: "short" } }],
      ["POST", ROUTES.actionsRun, { issueId: issue.id, actionId: "again", clientId: "c-1", confirm: "t-1" }],
    ]);
  });

  it("asks for the name of what cannot be taken back before Confirm goes, and sends what was typed", async () => {
    const asking = { prompt: "Erase cannot be taken back. Type its name to go ahead.", typeToConfirm: "Erase" };
    const below = (typed) => renderToStaticMarkup(
      <ConfirmBelow asking={asking} typed={typed} onType={() => {}} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(below("")).toContain('aria-label="Type Erase to go ahead"');
    expect(below("")).toMatch(/<button[^>]*disabled=""[^>]*>Confirm<\/button>/);
    expect(below(" erase ")).not.toMatch(/disabled=""/);
    expect(below("")).toMatch(/>Cancel<\/button><button[^>]*>Confirm<\/button>/);
    expect(below("")).toContain("Type <b>Erase</b> to go ahead");
    expect(typedRight(undefined, "")).toBe(true);
    expect(renderToStaticMarkup(
      <ConfirmBelow asking={{ prompt: "Run it again?" }} typed="" onType={() => {}} onConfirm={() => {}} onCancel={() => {}} />,
    )).not.toContain("<input");

    const send = vi.fn(async () => ({ ok: true, status: 200, body: { status: "done", recordId: "da-2" } }));
    setEosTransport({ ...fixtureTransport(reads), send });
    await runSurfaceAction({ issueId: issue.id, actionId: "erase", clientId: "c-3", confirm: "t-2", typed: "Erase" });
    expect(send.mock.calls[0][2]).toEqual({ issueId: issue.id, actionId: "erase", clientId: "c-3", confirm: "t-2", typed: "Erase" });
  });

  it("says so when a dev run refuses the press", async () => {
    const send = async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: POST /api/actions/run" } });
    setEosTransport({ ...fixtureTransport(reads), send });
    const answer = await runSurfaceAction({ issueId: issue.id, actionId: "again", clientId: "c-2" });
    expect(answer).toEqual({ status: "refused", reason: "This is a dev run: nothing runs from here." });
  });

  it("names the row a button in a list was pressed on by its id or its place, never by its values", async () => {
    const data = { title: "Overnight", stories: [{ url: "https://a.example" }, { url: "https://b.example" }] };
    expect(pressedRow(data, "s-1")).toEqual({ itemId: "s-1" });
    expect(pressedRow(data, 7)).toEqual({ itemId: "7" });
    expect(pressedRow(data, { url: "https://b.example" })).toEqual({ index: 1 });
    expect(pressedRow(data, { url: "https://elsewhere.example" })).toEqual({});
    expect(pressedRow(data, undefined)).toEqual({});
    const send = vi.fn(async () => ({ ok: true, status: 200, body: { status: "done", recordId: "da-2" } }));
    setEosTransport({ ...fixtureTransport(reads), send });
    await runSurfaceAction({ issueId: issue.id, actionId: "open", clientId: "c-2", index: 1 });
    expect(send.mock.calls[0][2]).toEqual({ issueId: issue.id, actionId: "open", clientId: "c-2", index: 1 });
  });
});

describe("a View's form send", () => {
  const form = {
    title: "Two answers", summary: "",
    ui: '<Form action="confirm" submit="Confirm"><Field bind="from" label="Not between" type="time" default="23:00"/></Form>',
    actions: { confirm: { label: "Confirm", kind: "send", text: "confirm", primary: true } },
  };

  it("is not drawn inside the frame: Eos draws it outside", () => {
    const html = renderToStaticMarkup(
      <UiProvider><SurfaceCard card={{ surface, issue, body: { view: form } }} routineName="Mail Triage" onSubmitOffer={() => {}} /></UiProvider>,
    );
    expect(html).toContain("Not between");
    expect(html).not.toContain("gv-form__foot");
    expect(html).not.toContain(">Confirm<");
  });

  it("is drawn by Eos as a primary button with its shortcut, Sent once it went, and why it did not go", () => {
    const submit = vi.fn();
    const ready = { label: "Confirm", phase: "idle", reason: "", ready: true, submit };
    expect(renderToStaticMarkup(<ViewSubmit offer={ready} shortcut="⌘↵" />)).toBe(
      '<button type="button" class="eos-btn eos-btn--primary">Confirm<span class="eos-needs-key"> ⌘↵</span></button>',
    );
    expect(renderToStaticMarkup(<ViewSubmit offer={{ ...ready, phase: "sent" }} />)).toContain(">Sent</button>");
    expect(renderToStaticMarkup(<ViewSubmit offer={{ ...ready, phase: "sending" }} />)).toContain("disabled");
    expect(renderToStaticMarkup(<ViewSubmit offer={ready} disabled />)).toContain("disabled");
    expect(renderToStaticMarkup(<ViewSubmit offer={{ ...ready, phase: "asking", ready: false }} />)).toBe("");
    expect(renderToStaticMarkup(<ViewSubmit offer={{ ...ready, phase: "error", reason: "Couldn't send" }} />)).toContain('<span class="eos-frame__send-error" role="alert">Couldn&#x27;t send</span>');
  });
});

describe("the facts of a View's options and its aside", () => {
  const asking = {
    title: "Mail Triage needs an answer", summary: "How it should reach you.",
    ui: '<Choice bind="way" question="How should Eos reach you?" options="Through your iPhone | An SMS provider"/>',
  };
  const facts = [{ option: "Through your iPhone", rows: [{ label: "Cost", value: "Free" }, { label: "Works", value: "While this Mac is on" }] }];
  const draw = (body) => renderToStaticMarkup(
    <UiProvider><SurfaceCard card={{ surface, issue, body: { view: asking, ...body } }} routineName="Mail Triage" /></UiProvider>,
  );

  it("draws each option's facts in its card, under its label", () => {
    const html = draw({ facts });
    const iphone = html.slice(html.indexOf("Through your iPhone") - 200, html.indexOf("An SMS provider"));
    expect(iphone).toContain('<span class="gv-choice__label">Through your iPhone</span>');
    expect(iphone).toContain('<span class="gv-choice__fact"><span class="gv-choice__fact-label">Cost</span><span class="gv-choice__fact-value">Free</span></span>');
    expect(iphone).toContain("While this Mac is on");
    expect(html).toContain("<span>An SMS provider</span>");
  });

  it("draws a View without them as it was", () => {
    const html = draw({});
    expect(html).not.toContain("gv-choice__facts");
    expect(html).toContain("<span>Through your iPhone</span>");
    expect(html).not.toContain("From outside text");
  });

  it("finds an option's facts by its label or its value", () => {
    const of = factsLookup([{ option: "sms", rows: [{ label: "Cost", value: "Per message" }] }]);
    expect(of("An SMS provider", "sms")).toEqual([{ label: "Cost", value: "Per message" }]);
    expect(of("Through your iPhone", "Through your iPhone")).toBeNull();
    expect(factsLookup(undefined)).toBeNull();
    expect(factsLookup([])).toBeNull();
  });

  it("says in the frame's strip that a run which read outside text made it", () => {
    expect(draw({ untrusted: true })).toContain('<span class="eos-frame__outside" title="The run read text from outside Eos. Its words show here as written.">From outside text</span>');
  });

  it("draws the aside's notes as titled plain paragraphs, never as markup, a link or a button", () => {
    const html = renderToStaticMarkup(<ViewAside notes={[
      { title: "Why Eos is asking", text: "It has no way to reach you." },
      { title: "<b>Now</b>", text: '<a href="https://evil.example">here</a> <button>Send</button>' },
    ]} />);
    expect(html).toContain('<section class="eos-needs-aside__part"><h2 class="eos-label">Why Eos is asking</h2><p class="eos-needs-aside__text">It has no way to reach you.</p></section>');
    expect(html).not.toMatch(/<(a|b|button)[ >]/);
    expect(html).toContain("&lt;a href=");
    expect(renderToStaticMarkup(<ViewAside notes={[]} />)).toBe("");
  });

  it("draws a fact that looks like markup as its text", () => {
    const html = draw({ facts: [{ option: "Through your iPhone", rows: [{ label: "Cost", value: "[Pay](https://evil.example) <button>Go</button>" }] }] });
    expect(html).toContain("[Pay](https://evil.example) &lt;button&gt;Go&lt;/button&gt;");
    expect(html).not.toContain('href="https://evil.example"');
  });
});
