import { describe, it, expect } from "vitest";
import { createUndoRouter } from "./undoRouter.js";

const target = (name, focused) => ({ name, ...(focused === undefined ? {} : { hasFocus: () => focused() }) });

describe("createUndoRouter", () => {
  it("routes to a focused editor over the composer", () => {
    const r = createUndoRouter();
    let focused = true;
    r.register(target("composer"));
    r.register(target("code", () => focused));
    expect(r.pick().name).toBe("code");
    focused = false;
    expect(r.pick().name).toBe("composer");
  });

  it("falls back to the newest focus-free target, restored on unregister", () => {
    const r = createUndoRouter();
    r.register(target("composer"));
    const release = r.register(target("template"));
    expect(r.pick().name).toBe("template");
    release();
    expect(r.pick().name).toBe("composer");
  });

  it("picks nothing when only unfocused editors are registered", () => {
    const r = createUndoRouter();
    r.register(target("code", () => false));
    expect(r.pick()).toBe(null);
  });
});
