import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlot } from "./registry.js";
import { _resetMainView, getMainView } from "./mainView.js";
import { getArchive, setArchiveViewing, _resetArchive } from "../state/archiveStore.js";
import { setMemoryViewing, _resetMemoryView } from "../state/memoryViewStore.js";

describe("createSlot", () => {
  it("lists items by order and notifies on add/remove", () => {
    const slot = createSlot();
    const cb = vi.fn();
    slot.subscribe(cb);
    const removeB = slot.add({ id: "b", order: 20 });
    slot.add({ id: "a", order: 10 });
    expect(slot.list().map((i) => i.id)).toEqual(["a", "b"]);
    removeB();
    expect(slot.list().map((i) => i.id)).toEqual(["a"]);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("re-adding an id replaces the item, and the old remover no longer touches it", () => {
    const slot = createSlot();
    const removeOld = slot.add({ id: "x", v: 1 });
    slot.add({ id: "x", v: 2 });
    expect(slot.list()).toEqual([{ id: "x", v: 2 }]);
    removeOld();
    expect(slot.get("x")).toEqual({ id: "x", v: 2 });
  });

  it("keeps a stable list reference between changes", () => {
    const slot = createSlot();
    slot.add({ id: "a" });
    expect(slot.list()).toBe(slot.list());
  });
});

describe("main view", () => {
  beforeEach(() => { _resetArchive(); _resetMemoryView(); _resetMainView(); });

  it("archive and memory are one main view at a time", () => {
    setArchiveViewing(true);
    expect(getArchive().archiveMode).toBe(true);
    setMemoryViewing(true);
    expect(getMainView()).toBe("memory");
    expect(getArchive().archiveMode).toBe(false);
    setArchiveViewing(false);
    expect(getMainView()).toBe("memory");
  });
});
