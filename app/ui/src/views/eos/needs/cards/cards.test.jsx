import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../../state/eos/transport.js";
import { _resetInbox, loadInboxItem, refreshInbox, useInbox } from "../../../../state/eos/inboxStore.js";
import { EosMain } from "../../EosMain.jsx";
import { _resetEosNav, eosLocation, openLocation } from "../../nav/eosNav.js";
import { actionsOf } from "./index.js";
import { pageOf } from "./DraftCard.jsx";
import inbox from "../../gallery/sample/inbox.json";
import inboxItems from "../../gallery/sample/inbox-items.json";

vi.mock("../../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
vi.mock("../../../../keymap/useKeymap.js", () => ({ useGlobalKeymap: () => {}, useKeybinding: () => {} }));

const byKind = Object.fromEntries(inboxItems.map((d) => [d.item.kind, d]));
const reads = {
  [ROUTES.inbox]: inbox,
  ...Object.fromEntries(inboxItems.map((d) => [ROUTES.inboxItem(d.item.id), d])),
};

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

const ok = async () => ({ ok: true, status: 200, body: {} });

function recording(sent = ok) {
  const fixture = fixtureTransport(reads);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

// The item of `kind` drawn on its screen.
async function screen(kind, detail = byKind[kind]) {
  setEosTransport(fixtureTransport({ ...reads, [ROUTES.inboxItem(detail.item.id)]: detail }));
  await refreshInbox();
  await loadInboxItem(detail.item.id);
  openLocation(`eos:/needs/${encodeURIComponent(detail.item.id)}`);
  return renderToStaticMarkup(<EosMain />);
}

const buttons = (html) => [...html.matchAll(/<div class="eos-actions eos-needs-item__actions">(.*?)<\/div>/g)][0]?.[1]
  .match(/<button[^>]*>([^<]*)/g).map((b) => b.replace(/<button[^>]*>/, ""));

// Runs the action labelled `label` the way its button does.
async function act(kind, label, values = {}) {
  const action = actionsOf(byKind[kind]).find((a) => a.label === label);
  return action.run(byKind[kind], values);
}

function current() {
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
  _resetEosNav();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("a run's permission ask", () => {
  it("names the tool, what it counts as and its target, with Allow once and Deny only", async () => {
    const html = await screen("permission");
    expect(html).toContain("A run wants to use <strong>Bash</strong>.");
    expect(html).toContain('<p class="eos-needs-card__class">Runs a command on this Mac</p>');
    expect(html).toContain('<pre class="eos-code eos-needs-card__target">git push origin review/470</pre>');
    expect(buttons(html)).toEqual(["Allow once", "Deny"]);
    expect(html).not.toContain("Always");
  });

  it("is answered through the recorded decision route, and leaves the list", async () => {
    await screen("permission");
    const t = recording();
    setEosTransport(t);
    expect(await act("permission", "Allow once")).toBe(true);
    expect(await act("permission", "Deny")).toBe(true);
    expect(t.send.mock.calls).toEqual([
      ["POST", ROUTES.pendingDecision("pa-7f3k1m9q"), { decision: "allow" }],
      ["POST", ROUTES.pendingDecision("pa-7f3k1m9q"), { decision: "deny", reason: "denied in Needs you" }],
    ]);
    expect(current().list.items.map((i) => i.id)).not.toContain("perm:pa-7f3k1m9q");
    expect(current().list.counts.open).toBe(inbox.counts.open - 1);
  });
});

describe("a run's question", () => {
  it("asks each question with a text answer, the run's options filling it in", async () => {
    const html = await screen("question");
    expect(html).toContain('<label for="eos-q-0" class="eos-needs-question__text">Which branch should the review compare against?</label>');
    expect(html).toContain('<button type="button" class="eos-chip" aria-pressed="false">release/2.4</button>');
    expect(html).toContain('<textarea id="eos-q-0" class="eos-needs-question__answer" rows="2"></textarea>');
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary" disabled="">Send answers');
  });

  it("sends the answers by question with the item's rev", async () => {
    await screen("question");
    const t = recording();
    setEosTransport(t);
    await act("question", "Send answers", { "Which branch should the review compare against?": "release/2.4" });
    expect(t.send.mock.calls).toEqual([[
      "POST", ROUTES.inboxAnswer(byKind.question.item.id),
      { rev: 1, answer: { kind: "question", answers: { "Which branch should the review compare against?": "release/2.4" } } },
    ]]);
  });
});

describe("the other cards", () => {
  it("offer each kind's declared actions, then Later and Discard", async () => {
    const expected = {
      run_start: ["Run", "Skip", "Later", "Discard"],
      routine_alert: ["Resume", "Keep paused", "Open", "Later", "Discard"],
      confirm_change: ["Confirm", "Reject", "Later", "Discard"],
      delivery_problem: ["Try again", "Edit and retry", "I sent it myself", "Don&#x27;t send", "Later", "Discard"],
      about_you: ["Yes, keep it", "No", "Edit"],
      freedom_offer: ["Allow", "Not now", "Later", "Discard"],
      capability_install: ["Install", "Not now", "Later", "Discard"],
      capability_attention: ["Check again", "Open", "Later", "Discard"],
    };
    for (const [kind, labels] of Object.entries(expected)) expect(buttons(await screen(kind)), kind).toEqual(labels);
  });

  it("say what the item is about in words", async () => {
    expect(await screen("confirm_change")).toContain("Post reviews to acme/game as you, instead of showing them only here.");
    const problem = await screen("delivery_problem");
    expect(problem).toContain("GitHub says the pull request is not there any more.");
    expect(problem).toContain('<p class="eos-needs-card__class">What it names is not there any more.</p>');
    const guess = await screen("about_you");
    expect(guess).toContain("You prefer short reviews with the blocking findings first.");
    expect(guess).toContain("Is this right about you?");
  });

  it("show a capability proposal, a capability's problem and a freedom offer in words", async () => {
    const proposal = await screen("capability_install");
    expect(proposal).toContain("<strong>Calendar</strong> · Reads today&#x27;s events from the Calendar app.");
    expect(proposal).toContain("List today&#x27;s events");
    expect(proposal).toContain("Reaches com.apple.iCal");
    const problem = await screen("capability_attention");
    expect(problem).toContain("macOS has not let it control the app it needs.");
    const offer = await screen("freedom_offer");
    expect(offer).toContain("<span>Draft, I send</span><span aria-hidden=\"true\"> → </span><strong>Send, then tell me</strong>");
    expect(offer).toContain("10 in a row went out as written.");
  });

  it("install a proposed capability through the Forge's own route, and check a capability again through its own", async () => {
    const t = recording();
    setEosTransport(t);
    await refreshInbox();
    await act("capability_install", "Install");
    expect(await act("capability_attention", "Check again")).toBe(false);
    const runId = byKind.capability_install.payload.runId;
    expect(t.send.mock.calls[0]).toEqual(["POST", ROUTES.forgeProposalAnswer(runId), { choice: "install" }]);
    expect(t.send.mock.calls[1].slice(0, 2)).toEqual(["POST", ROUTES.capabilityCheck("mail")]);
  });

  it("offer Install only once the live test reached the user, after a test they start", async () => {
    const sample = byKind.capability_install;
    const at = (state) => ({
      ...sample,
      payload: { ...sample.payload, settings: [{ name: "phone_number", label: "Your mobile number" }], liveTest: { action: "send_to_me", state } },
    });
    const before = await screen("capability_install", at("not_run"));
    expect(buttons(before)).toEqual(["Send a test", "Not now", "Later", "Discard"]);
    expect(before).toContain("Your mobile number");
    expect(buttons(await screen("capability_install", at("sent")))).toEqual(["Yes, it did", "No", "Not now", "Later", "Discard"]);
    expect(buttons(await screen("capability_install", at("not_alerted")))).toEqual(["Send a test", "Find another way", "Not now", "Later", "Discard"]);
    expect(buttons(await screen("capability_install", at("alerted")))).toEqual(["Install", "Not now", "Later", "Discard"]);

    const t = recording();
    setEosTransport(t);
    const send = actionsOf(at("not_run")).find((a) => a.label === "Send a test");
    expect(await send.run(at("not_run"), { "setting:phone_number": "+90 555 010 0000" })).toBe(false);
    expect(t.send.mock.calls[0]).toEqual([
      "POST", ROUTES.forgeProposalLiveTest(sample.payload.runId), { settings: { phone_number: "+90 555 010 0000" } },
    ]);
  });

  it("offer Repair through the Forge and the version before for a broken capability", async () => {
    const sample = byKind.capability_attention;
    const broken = {
      item: { ...sample.item, title: "Notes stopped working" },
      payload: { capabilityId: "notes-db", state: "broken", stateCode: "hash_mismatch", repair: true, goBack: "1.0.0" },
    };
    const html = await screen("capability_attention", broken);
    expect(buttons(html)).toEqual(["Check again", "Repair", "Go back", "Open", "Later", "Discard"]);
    expect(html).toContain("Version 1.0.0 still works on this Mac.");

    const t = recording(async () => ({ ok: true, status: 200, body: { runId: "rn-9" } }));
    setEosTransport(t);
    const run = (label) => actionsOf(broken).find((a) => a.label === label).run(broken, {});
    expect(await run("Repair")).toBe(false);
    expect(t.send.mock.calls[0]).toEqual([
      "POST", ROUTES.forge, { need: "Repair Notes stopped working: hash_mismatch", capabilityId: "notes-db" },
    ]);
    expect(eosLocation()).toBe("eos:/runs/rn-9");
    expect(await run("Go back")).toBe(false);
    expect(t.send.mock.calls[1]).toEqual(["POST", ROUTES.capabilityRollback("notes-db"), { version: "1.0.0" }]);
  });

  it("show a notice's one action under its own name, beside Dismiss", async () => {
    const notice = { ...byKind.notice, item: { ...byKind.notice.item, state: "open" } };
    expect(buttons(await screen("notice", notice))).toEqual(["Keep the Mac awake for schedules", "Dismiss", "Later", "Discard"]);
    expect(buttons(await screen("notice", { ...notice, payload: {} }))).toEqual(["Dismiss", "Later", "Discard"]);
  });

  it("answer through the inbox with the kind and choice", async () => {
    const t = recording();
    setEosTransport(t);
    await refreshInbox();
    await act("run_start", "Run");
    await act("routine_alert", "Keep paused");
    await act("confirm_change", "Reject");
    await act("delivery_problem", "I sent it myself");
    await act("notice", "Dismiss");
    const answers = t.send.mock.calls.map(([, , body]) => body.answer);
    expect(answers).toEqual([
      { kind: "run_start", choice: "run" },
      { kind: "routine_alert", choice: "keep_paused" },
      { kind: "confirm_change", choice: "reject" },
      { kind: "delivery_problem", choice: "mark_sent" },
      { kind: "notice", choice: "dismiss" },
    ]);
    expect(t.send.mock.calls.every(([method, path]) => method === "POST" && path.endsWith("/answer"))).toBe(true);
  });

  it("answer a delivery problem with each choice the core takes", async () => {
    const t = recording();
    setEosTransport(t);
    await refreshInbox();
    for (const label of ["Try again", "I sent it myself", "Don't send"]) await act("delivery_problem", label);
    expect(t.send.mock.calls.map(([, , body]) => body.answer)).toEqual(
      ["retry", "mark_sent", "discard"].map((choice) => ({ kind: "delivery_problem", choice })),
    );
  });

  it("open a failed send's result in its editor with Edit and retry, and try again with the edited result", async () => {
    const problem = byKind.delivery_problem;
    const original = problem.payload.doc;
    const values = {};
    const setValue = (key, value) => { values[key] = value; };
    const t = recording();
    setEosTransport(t);
    await loadInboxItem(problem.item.id);
    expect(await actionsOf(problem).find((a) => a.label === "Edit and retry").run(problem, values, setValue)).toBe(false);
    expect(values.edit).toEqual(original);
    expect(actionsOf(problem, values).map((a) => a.label)).not.toContain("Edit and retry");

    const { PlainCard } = await import("./PlainCard.jsx");
    const html = renderToStaticMarkup(<PlainCard detail={problem} values={values} setValue={setValue} />);
    expect(html).toContain("<textarea");
    expect(html).toContain("The login fix works");

    const edited = { ...original, parts: original.parts.filter((p) => p.key !== "c:2") };
    await act("delivery_problem", "Try again", { edit: edited });
    await act("delivery_problem", "Try again", { edit: original });
    expect(t.send.mock.calls).toEqual([
      ["POST", ROUTES.inboxAnswer(problem.item.id), { rev: 1, answer: { kind: "delivery_problem", choice: "retry", doc: edited } }],
      ["POST", ROUTES.inboxAnswer(problem.item.id), { rev: 1, answer: { kind: "delivery_problem", choice: "retry" } }],
    ]);
  });

  it("open an alert's routine without answering it", async () => {
    const t = recording();
    setEosTransport(t);
    expect(await act("routine_alert", "Open")).toBe(false);
    expect(eosLocation()).toBe("eos:/routines/rt-2x8k5n1q6w0r");
    expect(t.send).not.toHaveBeenCalled();
  });

  it("keep or dismiss a suggestion through its recorded routes", async () => {
    await screen("about_you");
    const t = recording();
    setEosTransport(t);
    await act("about_you", "Yes, keep it");
    await act("about_you", "No");
    expect(t.send.mock.calls.map(([, path]) => path)).toEqual([ROUTES.userMemoryApprove("um-2p6o0i4u8y"), ROUTES.userMemoryDismiss("um-2p6o0i4u8y")]);
  });

  it("keep a guess in the user's words after Edit, and as it is when the words did not change", async () => {
    await screen("about_you");
    const t = recording();
    setEosTransport(t);
    const values = {};
    actionsOf(byKind.about_you).find((a) => a.label === "Edit").run(byKind.about_you, values, (k, v) => { values[k] = v; });
    expect(values.text).toBe("You prefer short reviews with the blocking findings first.");
    expect(actionsOf(byKind.about_you, values).map((a) => a.label)).toEqual(["Yes, keep it", "No"]);
    await act("about_you", "Yes, keep it", values);
    expect(t.send).toHaveBeenCalledTimes(1);
    await act("about_you", "Yes, keep it", { text: "You prefer short reviews." });
    expect(t.send.mock.calls.slice(1)).toEqual([
      ["PUT", ROUTES.userMemory("um-2p6o0i4u8y"), { text: "You prefer short reviews." }],
      ["POST", ROUTES.userMemoryApprove("um-2p6o0i4u8y"), {}],
    ]);
  });

  it("answer a freedom offer with Allow or Not now", async () => {
    const offer = byKind.freedom_offer;
    const html = await screen("freedom_offer");
    expect(html).toContain("You sent its last 10 results as Eos made them.");
    const t = recording();
    setEosTransport(t);
    for (const label of ["Allow", "Not now"]) await actionsOf(offer).find((a) => a.label === label).run(offer, {});
    expect(t.send.mock.calls.map(([, , body]) => body.answer)).toEqual([
      { kind: "freedom_offer", choice: "accept" },
      { kind: "freedom_offer", choice: "not_now" },
    ]);
  });

  it("show a kind with no card as its title and summary, with Open and Later", async () => {
    const other = { ...byKind.confirm_change, item: { ...byKind.confirm_change.item, id: "ib-other0000001", kind: "suggestion", title: "Make it a routine?", summary: "You often ask for this." } };
    const html = await screen("suggestion", other);
    expect(html).toContain('<h1 class="eos-title">Make it a routine?</h1>');
    expect(html).toContain("You often ask for this.");
    expect(buttons(html)).toEqual(["Open", "Later", "Discard"]);
  });
});

describe("a page draft", () => {
  const draft = byKind.draft;
  const page = {
    ...draft,
    payload: {
      ...draft.payload,
      doc: {
        kind: "page.issue", channel: "mail", action: "send_mail",
        parts: [
          { key: "title", role: "field", text: "The Morning Build" },
          { key: "@issue", role: "issue", text: "si-7", meta: { surface: "sf-paper" } },
          { key: "to:boss", role: "recipient", text: "boss@acme.dev" },
        ],
      },
    },
  };

  it("names the page it sends and who it goes to, and is edited on the page, not as text", async () => {
    const html = await screen("draft", page);
    expect(html).toContain('<span class="eos-chip eos-result__locked">boss@acme.dev</span>');
    expect(html).not.toContain("The Morning Build</textarea>");
    expect(buttons(html)).not.toContain("Edit");
    expect(buttons(html)[0]).toMatch(/^Send/);
  });

  it("opens the issue Eos named, never one a field of the run's data names", () => {
    const planted = { ...page.payload.doc, parts: [{ key: "@issue", role: "field", text: "si-OTHER" }, ...page.payload.doc.parts] };
    expect(pageOf(planted)).toEqual({ surfaceId: "sf-paper", issueId: "si-7" });
  });
});
