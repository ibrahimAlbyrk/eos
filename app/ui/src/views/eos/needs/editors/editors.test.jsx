import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../../state/eos/transport.js";
import { _resetInbox, loadInboxItem, refreshInbox, saveInboxDraft, sendInboxDraft, useInbox } from "../../../../state/eos/inboxStore.js";
import { _resetRoutines } from "../../../../state/eos/routinesStore.js";
import { _resetRuns } from "../../../../state/eos/runsStore.js";
import { EosMain } from "../../EosMain.jsx";
import { _resetEosNav, eosLocation, openLocation } from "../../nav/eosNav.js";
import { actionsOf } from "../cards/index.js";
import { followReplacement, needsSave } from "../cards/DraftCard.jsx";
import { _resetCarried, carriedEdits, dropEdit, EDIT_TTL_MS, readEdit, writeEdit } from "../editDrafts.js";
import { docChanged, joinSuggestion, mailBody, sendLabel, splitSuggestion, withMailBody, withPart, withText } from "./editDoc.js";
import inbox from "../../gallery/sample/inbox.json";
import inboxItems from "../../gallery/sample/inbox-items.json";

vi.mock("../../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
vi.mock("../../../../keymap/useKeymap.js", () => ({ useGlobalKeymap: () => {}, useKeybinding: () => {} }));

const detailOf = Object.fromEntries(inboxItems.map((d) => [d.item.id, d]));
const REVIEW = "ib-8m2n6b0v4c1x";
const MAIL = "ib-6t1y5u9i3o7p";
const TEXT = "ib-2a5s9d3f7g1h";
const docOf = (id) => detailOf[id].payload.doc;
const reads = { [ROUTES.inbox]: inbox, ...Object.fromEntries(inboxItems.map((d) => [ROUTES.inboxItem(d.item.id), d])) };
const NOW = 1763460000000;

// A localStorage with the parts editDrafts uses.
function stubStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

function recording(sent, paths = reads) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

async function screen(id, transport = fixtureTransport(reads)) {
  setEosTransport(transport);
  await refreshInbox();
  await loadInboxItem(id);
  openLocation(`eos:/needs/${id}`);
  return renderToStaticMarkup(<EosMain />);
}

function inboxState() {
  let read;
  function Probe() {
    read = useInbox();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

beforeEach(() => {
  _resetInbox();
  _resetRoutines();
  _resetRuns();
  _resetEosNav();
  _resetCarried();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("editing a review", () => {
  const original = docOf(REVIEW);

  it("leaves an unticked comment out of the doc, and puts it back in its place", () => {
    const without = withPart(original, original, "c:1", false);
    expect(without.parts.map((p) => p.key)).toEqual(["event", "summary", "c:2"]);
    expect(sendLabel(original, without)).toBe("Send review with 1 of 2 comments");
    expect(withPart(without, original, "c:1", true)).toEqual(original);
  });

  it("sends a changed summary as the whole doc with its new text, and an untouched draft without a doc", () => {
    const changed = withText(original, "summary", "Blocks: the token is logged.");
    expect(docChanged(changed, original)).toBe(true);
    expect(sendLabel(original, changed)).toBe("Send edited review");
    expect(changed.parts.find((p) => p.key === "summary").text).toBe("Blocks: the token is logged.");
    expect(changed.parts.filter((p) => p.key !== "summary")).toEqual(original.parts.filter((p) => p.key !== "summary"));
    expect(sendLabel(original, original)).toBe("Send");
    expect(sendLabel(original, null)).toBe("Send");
  });

  it("keeps a comment's suggested code in its text as GitHub's suggestion block", () => {
    const text = joinSuggestion("Use the pool.", "pool.Clear();");
    expect(text).toBe("Use the pool.\n\n```suggestion\npool.Clear();\n```");
    expect(splitSuggestion(text)).toEqual({ body: "Use the pool.", code: "pool.Clear();" });
    expect(splitSuggestion(joinSuggestion("Body\n", "x"))).toEqual({ body: "Body\n", code: "x" });
    expect(splitSuggestion("No code here.")).toEqual({ body: "No code here.", code: null });
    expect(joinSuggestion("Only words.", "")).toBe("Only words.");
  });

  it("draws the verdict, summary and each finding with its place read-only, from a kept edit", async () => {
    writeEdit(REVIEW, withPart(original, original, "c:2", false), 2, Date.now());
    const html = await screen(REVIEW);
    expect(html).toContain('role="radiogroup" aria-labelledby="edit-event"');
    expect(html).toContain('aria-checked="true" class="eos-seg__opt">Request changes</button>');
    expect(html).toContain('<textarea id="edit-summary"');
    expect(html).toContain('<span class="eos-result__place">src/auth/login.rs:42</span>');
    expect(html).toContain('<li class="eos-edit__finding eos-edit__finding--out">');
    expect(html).toContain(">Send review with 1 of 2 comments<");
    expect(html).not.toContain(">Edit</button>");
  });

  it("edits a comment as the whole text GitHub posts, with no field the core does not send", async () => {
    const titled = { ...original, parts: original.parts.map((p) => (p.key === "c:1" ? { ...p, meta: { ...p.meta, title: "Token" } } : p)) };
    writeEdit(REVIEW, titled, 2, Date.now());
    const html = await screen(REVIEW);
    expect(html).not.toContain('aria-label="Title"');
    expect(html).toContain('aria-label="Comment"');
  });

  it("offers Edit on an untouched draft and shows a revert arrow only beside a changed field", async () => {
    let html = await screen(REVIEW);
    expect(html).toContain('<button type="button" class="eos-btn">Edit</button>');
    expect(html).not.toContain("eos-edit__revert");
    writeEdit(REVIEW, withText(original, "summary", "Shorter."), 2, Date.now());
    html = renderToStaticMarkup(<EosMain />);
    expect(html.match(/eos-edit__revert/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Put back the summary as Eos wrote it"');
  });
});

describe("editing a mail and a text", () => {
  it("edits a mail's subject and body, recipients locked and kept as they were", async () => {
    const original = docOf(MAIL);
    const edited = withMailBody(withText(original, "subject", "Paid"), "Hi Dana,\n\nIt is paid.\n\nThanks!");
    expect(edited.parts.map((p) => p.key)).toEqual(["subject", "p:1", "p:2", "p:3", "to:r-1"]);
    expect(mailBody(edited)).toBe("Hi Dana,\n\nIt is paid.\n\nThanks!");
    expect(edited.parts.find((p) => p.key === "to:r-1")).toEqual(original.parts.find((p) => p.key === "to:r-1"));
    expect(sendLabel(original, edited)).toBe("Send edited mail");
    writeEdit(MAIL, edited, 1, Date.now());
    const html = await screen(MAIL);
    expect(html).toContain('<span class="eos-chip eos-result__locked">dana@example.com</span><span class="eos-result__fixed">Fixed in the blueprint</span>');
    expect(html).toContain('<input id="edit-subject" type="text" class="eos-edit__line" value="Paid"/>');
    expect(html).not.toContain('value="dana@example.com"');
  });

  it("edits a text in one textarea", async () => {
    const original = docOf(TEXT);
    const edited = withText(original, "body", "Main is green.");
    expect(sendLabel(original, edited)).toBe("Send edited draft");
    writeEdit(TEXT, edited, 1, Date.now());
    expect(await screen(TEXT)).toContain('<textarea id="edit-body" class="eos-edit__text" rows="8">Main is green.</textarea>');
  });
});

describe("sending and saving edits", () => {
  it("sends the whole edited doc with the item's rev and forgets the kept edit", async () => {
    const edited = withPart(docOf(REVIEW), docOf(REVIEW), "c:2", false);
    writeEdit(REVIEW, edited, 2, Date.now());
    const t = recording(async () => ({ ok: true, status: 200, body: { deliveries: [] } }));
    await screen(REVIEW, t);
    const send = actionsOf(inboxState().details[REVIEW], {}).find((a) => a.primary);
    expect(await send.run(inboxState().details[REVIEW], {})).toBe(true);
    expect(t.send.mock.calls).toEqual([["POST", ROUTES.inboxSend(REVIEW), { rev: 2, doc: edited }]]);
    expect(readEdit(REVIEW, Date.now())).toBeNull();
  });

  it("keeps working edits in the core with PUT draft and takes the new rev", async () => {
    const edited = withText(docOf(REVIEW), "summary", "Shorter.");
    const row = { ...detailOf[REVIEW].item, rev: 3 };
    const t = recording(async () => ({ ok: true, status: 200, body: row }));
    await screen(REVIEW, t);
    expect(await saveInboxDraft(REVIEW, edited)).toBe(true);
    expect(t.send.mock.calls).toEqual([["PUT", ROUTES.inboxDraft(REVIEW), { rev: 2, doc: edited }]]);
    expect(inboxState().details[REVIEW]).toMatchObject({ item: { rev: 3 }, working: edited });
  });

  it("keeps an edit in the core only when it differs from what the core holds", () => {
    const detail = detailOf[REVIEW];
    const original = docOf(REVIEW);
    const edited = withText(original, "summary", "Mine.");
    expect(needsSave(detail, undefined)).toBe(false);
    expect(needsSave(detail, original)).toBe(false);
    expect(needsSave(detail, edited)).toBe(true);
    expect(needsSave({ ...detail, working: edited }, edited)).toBe(false);
    expect(needsSave({ ...detail, working: edited }, original)).toBe(true);
  });

  it("sends after a save in flight lands, on the rev it left", async () => {
    const edited = withText(docOf(REVIEW), "summary", "Mine.");
    await screen(REVIEW);
    const rev = inboxState().details[REVIEW].item.rev;
    let land;
    const t = recording((method) => (method === "PUT"
      ? new Promise((resolve) => { land = () => resolve({ ok: true, status: 200, body: { ...detailOf[REVIEW].item, rev: rev + 1 } }); })
      : Promise.resolve({ ok: true, status: 200, body: { deliveries: [] } })));
    setEosTransport(t);
    const saved = saveInboxDraft(REVIEW, edited);
    const sent = sendInboxDraft(REVIEW, edited);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.send.mock.calls.map(([method]) => method)).toEqual(["PUT"]);
    land();
    expect(await saved).toBe(true);
    expect(await sent).toBe(true);
    expect(t.send.mock.calls).toEqual([
      ["PUT", ROUTES.inboxDraft(REVIEW), { rev, doc: edited }],
      ["POST", ROUTES.inboxSend(REVIEW), { rev: rev + 1, doc: edited }],
    ]);
  });

  it("on 409 replaced opens the newer draft with the user's edits read-only beside it", async () => {
    const NEW = "ib-new000000001";
    const edited = withText(docOf(REVIEW), "summary", "My words.");
    writeEdit(REVIEW, edited, 2, Date.now());
    const replaced = { ...detailOf[REVIEW], item: { ...detailOf[REVIEW].item, state: "replaced" }, replacedBy: NEW };
    const newer = { ...detailOf[REVIEW], item: { ...detailOf[REVIEW].item, id: NEW, rev: 1 } };
    const paths = { ...reads, [ROUTES.inboxItem(REVIEW)]: replaced, [ROUTES.inboxItem(NEW)]: newer };
    await screen(REVIEW);
    setEosTransport(recording(async () => ({ ok: false, status: 409, body: { error: "already answered", state: "replaced" } }), paths));
    expect(await sendInboxDraft(REVIEW, edited)).toBe(false);
    await loadInboxItem(REVIEW);
    expect(inboxState().refused[REVIEW]).toEqual({ state: "replaced", answeredBy: undefined });
    followReplacement(inboxState().details[REVIEW]);
    expect(eosLocation()).toBe(`eos:/needs/${NEW}`);
    expect(carriedEdits(NEW)).toEqual(edited);
    await loadInboxItem(NEW);
    const html = renderToStaticMarkup(<EosMain />);
    expect(html).toContain('<div class="eos-draft eos-draft--beside">');
    expect(html).toContain('<section class="eos-draft__carried" aria-label="Your edits"><h2 class="eos-label">Your edits</h2>');
    expect(html).toContain("<md>My words.</md>");
  });

  it("on 409 changed reads the item again and keeps the edits to send on the new rev", async () => {
    const edited = withText(docOf(REVIEW), "summary", "Mine.");
    writeEdit(REVIEW, edited, 2, Date.now());
    const bumped = { ...detailOf[REVIEW], item: { ...detailOf[REVIEW].item, rev: 5 } };
    await screen(REVIEW);
    const t = recording(async () => ({ ok: false, status: 409, body: { error: "changed", rev: 5 } }), { ...reads, [ROUTES.inboxItem(REVIEW)]: bumped });
    setEosTransport(t);
    expect(await sendInboxDraft(REVIEW, edited)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inboxState().details[REVIEW].item.rev).toBe(5);
    expect(inboxState().refused[REVIEW]).toBeUndefined();
    expect(readEdit(REVIEW, Date.now()).doc).toEqual(edited);
  });
});

describe("kept edits", () => {
  it("hold at most twenty, the oldest going first, none older than seven days", () => {
    const doc = docOf(TEXT);
    for (let i = 0; i < 22; i++) writeEdit(`ib-${i}`, doc, 1, NOW + i);
    expect(readEdit("ib-0", NOW + 30)).toBeNull();
    expect(readEdit("ib-1", NOW + 30)).toBeNull();
    expect(readEdit("ib-2", NOW + 30)).toMatchObject({ doc, rev: 1, at: NOW + 2 });
    expect(localStorage.length).toBe(20);
    expect(readEdit("ib-21", NOW + 21 + EDIT_TTL_MS + 1)).toBeNull();
    writeEdit("ib-late", doc, 1, NOW + 2 * EDIT_TTL_MS);
    expect(localStorage.length).toBe(1);
    dropEdit("ib-late");
    expect(localStorage.length).toBe(0);
  });

  it("are ignored when storage fails", () => {
    globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => writeEdit(REVIEW, docOf(REVIEW), 1, NOW)).not.toThrow();
    expect(readEdit(REVIEW, NOW)).toBeNull();
    expect(() => dropEdit(REVIEW)).not.toThrow();
  });
});

describe("editing a Slack message", () => {
  it("edits the message's paragraphs, counts Slack's room and says it goes as the user without previews", async () => {
    const { SlackEditor } = await import("./SlackEditor.jsx");
    const doc = { kind: "slack.message", channel: "slack", action: "post_message",
      parts: [{ key: "p:1", role: "paragraph", text: "The build is green." }, { key: "p:2", role: "paragraph", text: "Two tests were flaky." }] };
    const html = renderToStaticMarkup(<SlackEditor original={doc} doc={doc} onChange={() => {}} />);
    expect(html).toContain('<label class="eos-edit__label" for="edit-slack">Message</label>');
    expect(html).toContain("The build is green.\n\nTwo tests were flaky.");
    expect(html).toContain(`${4000 - "The build is green.\n\nTwo tests were flaky.".length} characters left`);
    expect(html).toContain("@channel, @here and @everyone stay plain text.");
    const long = { ...doc, kind: "slack.reply", parts: [{ key: "p:1", role: "paragraph", text: "a".repeat(4010) }] };
    const over = renderToStaticMarkup(<SlackEditor original={long} doc={long} onChange={() => {}} />);
    expect(over).toContain("10 characters over Slack&#x27;s limit");
    expect(over).toContain(">Reply</label>");
    expect(sendLabel(doc, withMailBody(doc, "Green."))).toBe("Send edited message");
  });
});
