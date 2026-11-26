// Needs you's gallery states: the list with nothing, a little and a lot, and
// one item of every kind, a draft in each state its sends can be in.

import { ROUTES } from "../../../api/routes.js";
import inboxItems from "./sample/inbox-items.json";
import paper from "./samplePaper.js";

const MIN = 60 * 1000;
const DRAFT = "ib-8m2n6b0v4c1x";
const PAGE = "ib-pg7b3m1c0003";
const PROPOSAL = "ib-3c8v1b5n9m2q";
const at = (id) => `eos:/needs/${encodeURIComponent(id)}`;

// The item `id` changed by `change(detail)`, in its read and in the list.
const changed = (id, change) => (s) => {
  const path = ROUTES.inboxItem(id);
  const detail = change(s[path]);
  const list = s[ROUTES.inbox];
  return { ...s, [path]: detail, [ROUTES.inbox]: { ...list, items: list.items.map((i) => (i.id === id ? detail.item : i)) } };
};
const withItem = (change) => changed(DRAFT, (d) => ({ ...d, item: { ...d.item, ...change } }));
// The draft after its Send: its deliveries, and once it is out, answered here.
const withDeliveries = (deliveries, out = false) => changed(DRAFT, (d) => ({
  ...d, item: out ? { ...d.item, state: "done" } : d.item, deliveries: deliveries(), ...(out ? { answeredBy: "dashboard" } : {}),
}));

// The proposed capability with a live test due, at `state`: it texts the
// user's phone, so it asks for the number first.
const withLiveTest = (state) => changed(PROPOSAL, (d) => ({
  ...d,
  item: { ...d.item, title: "Add SMS?", summary: "Texts your phone when Mail Triage finds a mail worth it." },
  payload: {
    ...d.payload, capabilityId: "sms", name: "SMS", summary: "Sends a text message to your own number through your iPhone.",
    actions: [{ name: "send_to_me", summary: "Text your own number", class: "tell_user" }], reach: { hosts: [], apps: ["com.apple.MobileSMS"], files: [] },
    routines: [{ id: "rt-mail", name: "Mail Triage" }], settings: [{ name: "phone_number", label: "Your mobile number" }],
    liveTest: { action: "send_to_me", state },
  },
}));

// The item `id` waiting in the list as well, counted as the core counts it,
// so the badge, the sidebar and the item's pager say one number.
const listed = (id) => (s) => {
  const detail = s[ROUTES.inboxItem(id)];
  return detail ? putInList(s, detail.item) : s;
};

// `item` in the list (last, or first when `first`), its counts with it,
// unless it is there already.
export function putInList(s, item, first = false) {
  const list = s[ROUTES.inbox];
  if (list.items.some((i) => i.id === item.id)) return s;
  const bump = (counts, key) => (key ? { ...counts, [key]: (counts[key] ?? 0) + 1 } : counts);
  const counts = {
    ...list.counts,
    ...(item.state === "later" ? { later: list.counts.later + 1 } : { open: list.counts.open + 1 }),
    byKind: bump(list.counts.byKind, item.kind),
    byRoutine: bump(list.counts.byRoutine, item.routineId),
  };
  return { ...s, [ROUTES.inbox]: { ...list, items: first ? [item, ...list.items] : [...list.items, item], counts } };
}

// Every sample item waiting in the list, each as the list reads it.
function everything(s) {
  const list = s[ROUTES.inbox];
  const known = new Set(list.items.map((i) => i.id));
  const items = inboxItems.map((d) => s[ROUTES.inboxItem(d.item.id)].item).filter((i) => !known.has(i.id));
  return { ...s, [ROUTES.inbox]: { ...list, items: [...list.items, ...items] } };
}

// Morning Paper's third issue held as a draft before it goes to the user.
function pageDraft(s) {
  const newest = s[ROUTES.inbox].items[0].createdAt;
  const item = {
    id: PAGE, kind: "draft", state: "open", attention: "digest", routineId: paper.surface.routineId, runId: "rn-pg7b3m1c0003",
    title: "Morning Paper, issue 3", summary: "One story and two short notes.", rev: 1, createdAt: newest - 3 * MIN, updatedAt: newest - 3 * MIN,
  };
  const doc = {
    kind: "page.issue", channel: "mail", action: "send_mail",
    parts: [
      { key: "to:me", role: "recipient", text: "you, by mail" },
      { key: "@issue", role: "issue", text: "si-7b3m1c000003", meta: { surface: paper.surface.id } },
    ],
  };
  const list = s[ROUTES.inbox];
  return { ...s, [ROUTES.inboxItem(PAGE)]: { item, payload: { doc } }, [ROUTES.inbox]: { ...list, items: [item, ...list.items] } };
}

const clickText = (text) => () => [...document.querySelectorAll(".eos-body button")].find((b) => b.textContent.trim().startsWith(text))?.click();

const kind = (id, label, name) => ({ id: name, label: `Needs you · ${label}`, location: at(id), reads: listed(id) });

export const NEEDS_STATES = [
  { id: "needs-lots", label: "Needs you · a lot waiting", location: "eos:/needs", reads: everything },
  { id: "needs-loading", label: "Needs you · loading", location: "eos:/needs", answer: "loading" },
  { id: "needs-error", label: "Needs you · cannot read", location: "eos:/needs", answer: "error" },
  { id: "need-edit", label: "Needs you · a draft being edited", location: at(DRAFT), then: clickText("Edit") },
  { id: "need-mail", label: "Needs you · a mail to send", location: at("ib-6t1y5u9i3o7p"), reads: listed("ib-6t1y5u9i3o7p") },
  { id: "need-mail-edit", label: "Needs you · a mail being edited", location: at("ib-6t1y5u9i3o7p"), reads: listed("ib-6t1y5u9i3o7p"), then: clickText("Edit") },
  { id: "need-text", label: "Needs you · a note to send", location: at("ib-2a5s9d3f7g1h"), reads: listed("ib-2a5s9d3f7g1h") },
  { id: "need-stale", label: "Needs you · a draft its subject moved past", location: at(DRAFT), reads: withItem({ staleAt: Date.now() - 2 * MIN, staleReason: "3 new commits" }) },
  {
    id: "need-holding", label: "Needs you · a draft in its hold", location: at(DRAFT),
    reads: withDeliveries(() => [{ id: "dl-hold000001", state: "holding", sendAt: Date.now() + 9000 }]),
  },
  {
    id: "need-queued", label: "Needs you · a draft waiting its turn", location: at(DRAFT),
    reads: withDeliveries(() => [{ id: "dl-hold000001", state: "queued" }]),
  },
  {
    id: "need-sent", label: "Needs you · a draft sent, Undo open", location: at(DRAFT),
    reads: withDeliveries(() => [{ id: "dl-sent000001", state: "sent", undoUntil: Date.now() + 5 * MIN }], true),
  },
  {
    id: "need-wrong", label: "Needs you · a draft sent and marked wrong", location: at(DRAFT),
    reads: withDeliveries(() => [{ id: "dl-sent000001", state: "sent", undoUntil: 0, wrong: true }], true),
  },
  {
    id: "need-answered", label: "Needs you · answered on the iPhone", location: at(DRAFT),
    reads: changed(DRAFT, (d) => ({ ...d, item: { ...d.item, state: "done" }, answeredBy: "phone" })),
  },
  { id: "need-page", label: "Needs you · a page issue to send", location: at(PAGE), reads: pageDraft },
  { id: "need-loading", label: "Needs you · an item loading", location: at(DRAFT), answer: "loading" },
  { id: "need-error", label: "Needs you · an item that cannot be read", location: at(DRAFT), answer: "error" },
  kind("ib-3k9d2f7h1j5l", "a question", "need-question"),
  kind("perm:pa-7f3k1m9q", "a run asks to use a tool", "need-permission"),
  kind("ib-5q1w9e3r7t2y", "a routine paused", "need-alert"),
  kind("ib-1q5w9e3r7t0y", "a send that failed", "need-problem"),
  { id: "need-problem-edit", label: "Needs you · a failed send being edited", location: at("ib-1q5w9e3r7t0y"), reads: listed("ib-1q5w9e3r7t0y"), then: clickText("Edit and retry") },
  kind("ib-6f2g8h4j0k1l", "more freedom offered", "need-freedom"),
  kind(PROPOSAL, "a capability proposed", "need-install"),
  ...[["not_run", "test"], ["sent", "sent"], ["failed", "failed"], ["alerted", "reached"], ["not_alerted", "missed"]].map(([state, name]) => ({
    id: `need-install-${name}`, label: `Needs you · a capability's live test, ${state.replace("_", " ")}`, location: at(PROPOSAL), reads: withLiveTest(state),
  })),
  kind("ib-7x2z6c0v4b8n", "a capability needs a look", "need-attention"),
  kind("sugg:um-2p6o0i4u8y", "a guess about you", "need-about"),
  kind("ib-9c3v7b1n5m2k", "a change to confirm", "need-confirm"),
  kind("ib-4e8r2t6y0u3i", "a run to start", "need-runstart"),
  kind("ib-0z4x8c2v6b9n", "a notice put aside", "need-notice"),
];
