import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: { getWorkerAttachments: vi.fn() },
}));
vi.mock("./eventsStore.js", () => ({
  attach: vi.fn(() => () => {}),
}));

import { api } from "../api/client.js";
import { attach as attachEvents } from "./eventsStore.js";
import { attach, subscribe, getSnapshot, _reset } from "./chatAttachmentsStore.js";

let n = 0;
const wid = () => `caw${n++}`;
const flush = () => new Promise((r) => setTimeout(r, 0));

// A server-shaped baseline attachment (already unioned + enriched daemon-side).
const baseAtt = (path, kind, messageId, ts) => ({ label: `[${path.split("/").pop()}]`, kind, path, messageId, ts });

// A user_message event row carrying an attachments suffix (the live-fold source).
const userRow = (id, ts, paths) => ({
  id,
  ts,
  type: "user_message",
  payload: JSON.stringify({
    text: "hi" + (paths.length ? "\n\nattachments:\n" + paths.map(([p, k]) => `- [${p.split("/").pop()}] (${k}): ${p}`).join("\n") : ""),
  }),
});

// The onNewest callback the store handed eventsStore.attach for this worker.
const onNewestFor = (w) => {
  const call = attachEvents.mock.calls.find((c) => c[0] === w);
  return call?.[1]?.onNewest;
};

beforeEach(() => {
  vi.clearAllMocks();
  _reset();
});

describe("chatAttachmentsStore", () => {
  it("loads the full-history baseline on attach", async () => {
    const w = wid();
    api.getWorkerAttachments.mockResolvedValue([
      baseAtt("/img/a.png", "image", 1, 10),
      baseAtt("/docs/b.pdf", "file", 2, 20),
    ]);
    attach(w);
    await flush();
    const snap = getSnapshot(w);
    expect(snap.loaded).toBe(true);
    expect(snap.attachments.map((a) => a.path)).toEqual(["/img/a.png", "/docs/b.pdf"]);
    expect(api.getWorkerAttachments).toHaveBeenCalledWith(w);
  });

  it("folds in new user_message attachments live and publishes to subscribers", async () => {
    const w = wid();
    api.getWorkerAttachments.mockResolvedValue([baseAtt("/img/a.png", "image", 1, 10)]);
    const cb = vi.fn();
    subscribe(w, cb);
    attach(w);
    await flush();
    cb.mockClear();

    onNewestFor(w)(w, [userRow(5, 50, [["/new/c.txt", "file"]])]);
    expect(cb).toHaveBeenCalled();
    expect(getSnapshot(w).attachments.map((a) => a.path)).toEqual(["/img/a.png", "/new/c.txt"]);
  });

  it("dedupes by path — a later row keeps the earliest messageId/ts and adds no duplicate", async () => {
    const w = wid();
    api.getWorkerAttachments.mockResolvedValue([baseAtt("/img/a.png", "image", 1, 10)]);
    attach(w);
    await flush();

    // Same path re-referenced by a later message: no duplicate, earliest wins.
    onNewestFor(w)(w, [userRow(9, 90, [["/img/a.png", "image"]])]);
    const snap = getSnapshot(w);
    const forPath = snap.attachments.filter((a) => a.path === "/img/a.png");
    expect(forPath).toHaveLength(1);
    expect(forPath[0]).toMatchObject({ messageId: 1, ts: 10 });
  });

  it("ignores non-user_message rows and rows without attachments", async () => {
    const w = wid();
    api.getWorkerAttachments.mockResolvedValue([]);
    attach(w);
    await flush();

    onNewestFor(w)(w, [
      { id: 3, ts: 30, type: "jsonl", payload: JSON.stringify({ text: "x\n\nattachments:\n- [z] (file): /z" }) },
      userRow(4, 40, []),
    ]);
    expect(getSnapshot(w).attachments).toHaveLength(0);
  });
});
