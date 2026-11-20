import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { fixtureTransport, setEosTransport } from "./transport.js";
import {
  _resetInbox, applyInboxChange, applyInboxDelivery, byNeedsOrder, ensureInboxLoaded, loadInboxItem, refreshInbox, resyncInbox, useInbox,
} from "./inboxStore.js";
import inbox from "../../views/eos/gallery/sample/inbox.json";

const [perm, question, alert, draft] = inbox.items;

function recording(paths) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(fixture.send) };
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

const detailOf = (item, extra = {}) => ({ item, payload: {}, ...extra });

beforeEach(() => _resetInbox());
afterEach(() => setEosTransport(null));

describe("the Needs-you list", () => {
  it("loads once after the first paint, with its counts and the chats that wait", async () => {
    const t = recording({ [ROUTES.inbox]: inbox });
    setEosTransport(t);
    expect(current().list).toBeNull();
    ensureInboxLoaded();
    ensureInboxLoaded();
    await vi.waitFor(() => expect(current().list).toEqual(inbox));
    expect(t.get).toHaveBeenCalledTimes(1);
  });

  it("orders as the core does: open before later, by attention, newest first", () => {
    const shuffled = [...inbox.items].reverse();
    expect(shuffled.sort(byNeedsOrder).map((i) => i.id)).toEqual(inbox.items.map((i) => i.id));
  });

  it("says it could not load", async () => {
    setEosTransport(fixtureTransport({}));
    await refreshInbox();
    expect(current()).toMatchObject({ list: null, listFailed: true });
  });
});

describe("inbox:change", () => {
  beforeEach(async () => {
    setEosTransport(fixtureTransport({ [ROUTES.inbox]: inbox }));
    await refreshInbox();
  });

  it("drops an item that no longer waits at once, without a read, and takes the core's open count", () => {
    const t = recording({});
    setEosTransport(t);
    applyInboxChange({ id: question.id, kind: "question", state: "answered", routineId: question.routineId, rev: 2, open: 4 });
    const { list } = current();
    expect(list.items.map((i) => i.id)).not.toContain(question.id);
    expect(list.counts.open).toBe(4);
    expect(list.counts.byKind.question).toBeUndefined();
    expect(list.counts.byRoutine[question.routineId]).toBe(inbox.counts.byRoutine[question.routineId] - 1);
    expect(t.get).not.toHaveBeenCalled();
  });

  it("reads a new item and puts it where Needs you's order puts it", async () => {
    const fresh = { ...draft, id: "ib-new000000001", attention: "interrupt", createdAt: alert.createdAt + 1, updatedAt: alert.createdAt + 1 };
    const t = recording({ [ROUTES.inboxItem(fresh.id)]: detailOf(fresh) });
    setEosTransport(t);
    applyInboxChange({ id: fresh.id, kind: "draft", state: "open", routineId: fresh.routineId, rev: 1, open: 6 });
    await vi.waitFor(() => expect(current().list.items.map((i) => i.id)).toContain(fresh.id));
    const ids = current().list.items.map((i) => i.id);
    expect(ids.indexOf(fresh.id)).toBe(ids.indexOf(alert.id) - 1);
    expect(current().list.counts).toMatchObject({ open: 6, byKind: { draft: 2 } });
    expect(t.get.mock.calls).toEqual([[ROUTES.inboxItem(fresh.id)]]);
    // Only an item opened keeps its detail.
    expect(current().details).toEqual({});
  });

  it("moves an item put aside to the end, among the later ones", async () => {
    const later = { ...question, state: "later", rev: 2 };
    setEosTransport(fixtureTransport({ [ROUTES.inboxItem(question.id)]: detailOf(later) }));
    applyInboxChange({ id: question.id, kind: "question", state: "later", rev: 2, open: 4 });
    await vi.waitFor(() => expect(current().list.items.at(-2)).toEqual(later));
    expect(current().list.counts).toMatchObject({ open: 4, later: 2 });
  });

  it("reads an open item again when it is answered elsewhere, to say who answered", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.inboxItem(draft.id)]: detailOf(draft) }));
    await loadInboxItem(draft.id);
    const answered = detailOf({ ...draft, state: "answered", rev: 3 }, { answeredBy: "phone", answeredAt: 1763454000000 });
    setEosTransport(fixtureTransport({ [ROUTES.inboxItem(draft.id)]: answered }));
    applyInboxChange({ id: draft.id, kind: "draft", state: "answered", rev: 3, open: 4 });
    expect(current().list.items.map((i) => i.id)).not.toContain(draft.id);
    await vi.waitFor(() => expect(current().details[draft.id].answeredBy).toBe("phone"));
    expect(current().list.items.map((i) => i.id)).not.toContain(draft.id);
  });
});

describe("before anything loaded", () => {
  it("reads nothing and changes nothing", () => {
    const t = recording({});
    setEosTransport(t);
    applyInboxChange({ id: perm.id, kind: "permission", state: "open", rev: 1, open: 1 });
    applyInboxChange({ id: perm.id, kind: "permission", state: "withdrawn", rev: 1, open: 0 });
    resyncInbox();
    expect(t.get).not.toHaveBeenCalled();
    expect(current()).toMatchObject({ list: null, details: {} });
  });
});

describe("resync", () => {
  it("reads the list and every open item again", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.inbox]: inbox, [ROUTES.inboxItem(draft.id)]: detailOf(draft) }));
    ensureInboxLoaded();
    await loadInboxItem(draft.id);
    const t = recording({ [ROUTES.inbox]: inbox, [ROUTES.inboxItem(draft.id)]: detailOf(draft) });
    setEosTransport(t);
    resyncInbox();
    expect(t.get.mock.calls).toEqual([[ROUTES.inbox], [ROUTES.inboxItem(draft.id)]]);
  });
});

describe("inbox:delivery", () => {
  it("moves the send of a draft on screen at once, and reads the draft again once it went out", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.inboxItem(draft.id)]: detailOf(draft, { deliveries: [{ id: "dl-1", state: "holding", sendAt: 10 }] }) }));
    await loadInboxItem(draft.id);
    const t = recording({ [ROUTES.inboxItem(draft.id)]: detailOf(draft, { deliveries: [{ id: "dl-1", state: "sent", undoUntil: 99 }] }) });
    setEosTransport(t);
    applyInboxDelivery({ id: "dl-1", itemId: draft.id, runId: "rn-1", state: "holding", sendAt: 20 });
    applyInboxDelivery({ id: "dl-2", itemId: draft.id, runId: "rn-1", state: "holding", sendAt: 20 });
    expect(current().details[draft.id].deliveries).toEqual([{ id: "dl-1", state: "holding", sendAt: 20 }, { id: "dl-2", state: "holding", sendAt: 20 }]);
    expect(t.get).not.toHaveBeenCalled();
    applyInboxDelivery({ id: "dl-1", itemId: draft.id, runId: "rn-1", state: "sent" });
    await vi.waitFor(() => expect(current().details[draft.id].deliveries).toEqual([{ id: "dl-1", state: "sent", undoUntil: 99 }]));
    expect(t.get.mock.calls).toEqual([[ROUTES.inboxItem(draft.id)]]);
  });

  it("leaves alone a send whose draft is not open here", () => {
    const t = recording({});
    setEosTransport(t);
    applyInboxDelivery({ id: "dl-1", itemId: draft.id, runId: "rn-1", state: "sent" });
    applyInboxDelivery({ id: "dl-9", runId: "rn-1", state: "sent" });
    expect(current().details).toEqual({});
    expect(t.get).not.toHaveBeenCalled();
  });
});
