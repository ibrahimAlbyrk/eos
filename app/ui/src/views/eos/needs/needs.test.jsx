import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetInbox, loadInboxItem, refreshInbox, sendInboxDraft, applyInboxChange } from "../../../state/eos/inboxStore.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { _resetRuns, loadRun } from "../../../state/eos/runsStore.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, eosLocation, openLocation } from "../nav/eosNav.js";
import { _resetNeedsCursor } from "./NeedsYouList.jsx";
import inbox from "../gallery/sample/inbox.json";
import inboxItems from "../gallery/sample/inbox-items.json";
import routines from "../gallery/sample/routines.json";
import runDetail from "../gallery/sample/run-detail.json";

// The server renderer has no DOM for DOMPurify: agent-written text shows as
// it would go into the sanitiser.
vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));

const bindings = vi.hoisted(() => []);
vi.mock("../../../keymap/useKeymap.js", () => ({
  useGlobalKeymap: () => {},
  useKeybinding: (b) => { bindings.push(b); },
}));

const DEV_RUN_TEXT = "This is a dev run: nothing starts or leaves the Mac.";
const detailOf = Object.fromEntries(inboxItems.map((d) => [d.item.id, d]));
const DRAFT = "ib-8m2n6b0v4c1x";
const MAIL = "ib-6t1y5u9i3o7p";
const TEXT = "ib-2a5s9d3f7g1h";
const reads = {
  [ROUTES.inbox]: inbox,
  [ROUTES.routines]: routines,
  [ROUTES.run(runDetail.run.id)]: runDetail,
  ...Object.fromEntries(inboxItems.map((d) => [ROUTES.inboxItem(d.item.id), d])),
};

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function recording(paths, sent = async () => ({ ok: true, status: 200, body: {} })) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

function at(location) {
  openLocation(location);
  bindings.length = 0;
  return renderToStaticMarkup(<EosMain />);
}

// A key as the keymap would pass it.
function press(key, extra = {}) {
  const e = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: "BODY" }, preventDefault: vi.fn(), ...extra };
  const binding = bindings.findLast((b) => b.match(e));
  binding?.run({}, e);
  return Boolean(binding);
}

const groups = (html) => [...html.matchAll(/<h2 class="eos-label">([^<]*)</g)].map((m) => m[1]);
const titles = (html) => [...html.matchAll(/<span class="eos-needs-row__title">([^<]*)</g)].map((m) => m[1]);

async function loaded(paths = reads) {
  setEosTransport(fixtureTransport(paths));
  await refreshRoutines();
  await refreshInbox();
}

beforeEach(() => {
  _resetInbox();
  _resetRoutines();
  _resetRuns();
  _resetEosNav();
  _resetNeedsCursor();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("the Needs-you list", () => {
  it("groups the items in order, leaving empty groups out, each row with its routine, title, summary, action and Later", async () => {
    await loaded();
    const html = at("eos:/needs");
    expect(html).toContain('<h1 class="eos-title">Needs you</h1>');
    expect(groups(html)).toEqual(["To check and send", "Questions", "Problems", "Later"]);
    expect(titles(html)).toEqual([
      "Review of #470 Fix the login",
      "Allow Bash?", "Which branch should the review compare against?", "You prefer short reviews with the blocking findings first.",
      "Mail Triage is paused",
      "A run started late",
    ]);
    const row = (title) => html.split('<li class="eos-needs-row"').find((part) => part.includes(`eos-needs-row__title">${title}<`));
    const draft = row("Review of #470 Fix the login");
    expect(draft).toContain('<span class="eos-needs-row__routine">PR Review</span>');
    expect(draft).toContain('<span class="eos-needs-row__summary">Two findings, one of them blocking.</span>');
    expect(draft).toContain('<button type="button" class="eos-btn eos-btn--primary">Review</button><button type="button" class="eos-btn">Later</button>');
    expect(row("Allow Bash?")).toContain(">Decide</button>");
    expect(row("Allow Bash?")).not.toContain(">Later<");
    expect(row("Mail Triage is paused")).toContain('<span class="eos-needs-row__routine">Mail Triage</span>');
    expect(row("A run started late")).not.toContain(">Later<");
  });

  it("names the chats waiting in Agents in one line", async () => {
    await loaded();
    expect(at("eos:/needs")).toContain('<p class="eos-needs-agents">2 chats in Agents are waiting for you.</p>');
    await loaded({ ...reads, [ROUTES.inbox]: { ...inbox, agentsWaiting: 1 } });
    expect(at("eos:/needs")).toContain("1 chat in Agents is waiting for you.");
    await loaded({ ...reads, [ROUTES.inbox]: { ...inbox, agentsWaiting: 0 } });
    expect(at("eos:/needs")).not.toContain("eos-needs-agents");
  });

  it("moves with J and K and opens with Enter, but not while typing", async () => {
    await loaded();
    at("eos:/needs");
    expect(press("j")).toBe(true);
    let html = at("eos:/needs");
    expect(html).toContain('<li class="eos-needs-row on" aria-current="true">');
    expect(html.split('class="eos-needs-row on"')[1]).toContain("Allow Bash?");
    press("j");
    at("eos:/needs");
    press("k");
    html = at("eos:/needs");
    expect(html.split('class="eos-needs-row on"')[1].split("</li>")[0]).toContain("Allow Bash?");
    expect(press("j", { target: { tagName: "TEXTAREA" } })).toBe(false);
    expect(press("j", { metaKey: true })).toBe(false);

    expect(press("Enter", { target: { tagName: "BUTTON" } })).toBe(false);
    expect(press("Enter", { target: { tagName: "A" } })).toBe(false);
    expect(eosLocation()).toBe("eos:/needs");
    press("Enter");
    expect(eosLocation()).toBe("eos:/needs/perm%3Apa-7f3k1m9q");
  });

  it("says nothing needs the user, with the item answered last", async () => {
    const answered = { ...inboxItems[0].item, state: "answered", updatedAt: Date.now() - 5 * 60_000 };
    await loaded({
      ...reads,
      [ROUTES.inbox]: { items: [], counts: { open: 0, later: 0, byKind: {}, byRoutine: {} }, agentsWaiting: 0 },
      [`${ROUTES.inbox}?state=answered`]: { items: [answered], counts: inbox.counts, agentsWaiting: 0 },
    });
    expect(at("eos:/needs")).toContain('<p class="eos-note">Nothing needs you.</p>');
    const { loadLastAnswered } = await import("../../../state/eos/inboxStore.js");
    await loadLastAnswered();
    expect(at("eos:/needs")).toContain('<p class="eos-needs-last">Last: Review of #470 Fix the login, 5m ago.</p>');
  });

  it("draws many items, loading blocks, and a failed read in words", async () => {
    expect(at("eos:/needs")).toContain('<div class="eos-skeleton" aria-busy="true" aria-label="Loading">');
    await loaded({});
    expect(at("eos:/needs")).toContain("Couldn&#x27;t load what needs you.");
    const many = Array.from({ length: 100 }, (_, n) => ({ ...inbox.items[3], id: `ib-${String(n).padStart(12, "0")}`, createdAt: 1763452990000 - n }));
    await loaded({ ...reads, [ROUTES.inbox]: { ...inbox, items: many, nextCursor: "1.0.x" } });
    expect(titles(at("eos:/needs"))).toHaveLength(100);
  });
});

describe("a draft", () => {
  it("shows a review with its line comments read-only, the run's checks and team, and Send", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    await loadRun(runDetail.run.id);
    const html = at(`eos:/needs/${DRAFT}`);
    expect(html).toContain('<button type="button" class="eos-crumb">Needs you</button>');
    expect(html).toContain('<h1 class="eos-title">Review of #470 Fix the login</h1>');
    expect(html).toContain("<span>1 of 6</span>");
    expect(html).toContain('<p class="eos-result__event">Request changes</p>');
    expect(html).toContain("<md>The login fix works, but **one change blocks**: the token is logged.</md>");
    expect(html).toContain('<span class="eos-result__place">src/auth/login.rs:42</span>');
    expect(html).not.toContain("<textarea");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Send<span class="eos-needs-key">');
    expect(html).toContain(">Later</button>");
    expect(html).toContain(">Discard</button>");
    expect(html).toContain("Checked before it reached you");
    expect(html).toContain("It passed every check.");
    expect(html).toContain("Who worked on it");
    expect(html).toContain("In all $0.420");
  });

  it("shows a mail with its recipients locked, and a text", async () => {
    await loaded();
    await loadInboxItem(MAIL);
    let html = at(`eos:/needs/${MAIL}`);
    expect(html).toContain('<p class="eos-result__subject">Re: The invoice for October</p>');
    expect(html).toContain('<p class="eos-result__para">Thanks, the invoice is paid. The receipt is attached.</p>');
    expect(html).toContain('<span class="eos-chip eos-result__locked">dana@example.com</span><span class="eos-result__fixed">Fixed in the blueprint</span>');
    expect(html).not.toContain("<input");

    await loadInboxItem(TEXT);
    html = at(`eos:/needs/${TEXT}`);
    expect(html).toContain("<md>Main is green again after **#471**.</md>");
    expect(html).not.toContain("eos-needs-aside");
  });

  it("is sent with ⌘↵ with its rev, then the next item opens", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    const t = recording(reads);
    setEosTransport(t);
    at(`eos:/needs/${DRAFT}`);
    expect(press("Enter", { metaKey: true })).toBe(true);
    await vi.waitFor(() => expect(eosLocation()).toBe("eos:/needs/perm%3Apa-7f3k1m9q"));
    expect(t.send.mock.calls).toEqual([["POST", ROUTES.inboxSend(DRAFT), { rev: 2 }]]);
  });

  it("hides Why it looks like this and Next time while memory is not there", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    const html = at(`eos:/needs/${DRAFT}`);
    expect(html).not.toContain("Why it looks like this");
    expect(html).not.toContain("Next time");
  });
});

describe("an item that no longer waits", () => {
  it("says it was answered on the iPhone, without its actions", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    const answered = { ...detailOf[DRAFT], item: { ...detailOf[DRAFT].item, state: "answered", rev: 3 }, answeredBy: "phone" };
    setEosTransport(fixtureTransport({ ...reads, [ROUTES.inboxItem(DRAFT)]: answered }));
    applyInboxChange({ id: DRAFT, kind: "draft", state: "answered", rev: 3, open: 4 });
    await vi.waitFor(() => expect(at(`eos:/needs/${DRAFT}`)).toContain('<p class="eos-needs-closed" role="status">Answered on your iPhone.</p>'));
    const html = at(`eos:/needs/${DRAFT}`);
    expect(html).not.toContain(">Send<");
    expect(html).toContain('<p class="eos-result__event">Request changes</p>');
  });

  it("says a newer draft replaced it, and opens that one", async () => {
    const replaced = { ...detailOf[DRAFT], item: { ...detailOf[DRAFT].item, state: "replaced" }, replacedBy: "ib-new000000001" };
    await loaded({ ...reads, [ROUTES.inboxItem(DRAFT)]: replaced });
    await loadInboxItem(DRAFT);
    const html = at(`eos:/needs/${DRAFT}`);
    expect(html).toContain("Replaced by a newer draft. <button type=\"button\" class=\"eos-link\">Open the newer draft</button>");
  });
});

describe("answers", () => {
  it("say another device answered first (409 with answeredBy)", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    setEosTransport(recording(reads, async () => ({ ok: false, status: 409, body: { error: "already answered", state: "answered", answeredBy: "peer" } })));
    expect(await sendInboxDraft(DRAFT)).toBe(false);
    expect(at(`eos:/needs/${DRAFT}`)).toContain("Answered on your other Mac.");
  });

  it("read the item again when it changed (409 with rev)", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    const t = recording(reads, async () => ({ ok: false, status: 409, body: { error: "changed", rev: 5 } }));
    setEosTransport(t);
    await sendInboxDraft(DRAFT);
    expect(t.get).toHaveBeenCalledWith(ROUTES.inboxItem(DRAFT));
    expect(at(`eos:/needs/${DRAFT}`)).toContain(">Send<");
  });

  it("say a dev run sends nothing, instead of a failure", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    setEosTransport(recording(reads, async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: this request sends" } })));
    await sendInboxDraft(DRAFT);
    expect(at(`eos:/needs/${DRAFT}`)).toContain(`<p class="eos-note" role="status">${DEV_RUN_TEXT}</p>`);
  });

  it("wait while the core is unreachable, the last item kept and Send held back", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    setEosTransport({ get: async () => { throw new Error("offline"); }, send: async () => { throw new Error("offline"); } });
    await refreshInbox();
    const html = at(`eos:/needs/${DRAFT}`);
    expect(html).toContain('<p class="eos-needs-offline" role="status">Reconnecting…</p>');
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary" disabled="" title="Reconnecting…">Send');
    expect(html).toContain('<p class="eos-result__event">Request changes</p>');
  });

  it("put an item aside at once", async () => {
    await loaded();
    const t = recording(reads);
    setEosTransport(t);
    const { laterInboxItem } = await import("../../../state/eos/inboxStore.js");
    await laterInboxItem(DRAFT);
    expect(t.send.mock.calls).toEqual([["POST", ROUTES.inboxLater(DRAFT), {}]]);
    expect(groups(at("eos:/needs")).at(-1)).toBe("Later");
    expect(titles(at("eos:/needs")).at(-2)).toBe("Review of #470 Fix the login");
  });
});

describe("paging", () => {
  it("goes to the next and previous item with J and K", async () => {
    await loaded();
    await loadInboxItem(DRAFT);
    at(`eos:/needs/${DRAFT}`);
    press("j");
    expect(eosLocation()).toBe("eos:/needs/perm%3Apa-7f3k1m9q");
    at("eos:/needs/perm%3Apa-7f3k1m9q");
    press("k");
    expect(eosLocation()).toBe(`eos:/needs/${DRAFT}`);
  });

  it("says an item that is gone is no longer here", async () => {
    await loaded();
    await loadInboxItem("ib-gone00000001");
    expect(at("eos:/needs/ib-gone00000001")).toContain("This is no longer in Needs you.");
  });
});
