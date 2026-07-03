import { describe, it, expect, beforeEach } from "vitest";
import { notify } from "./notify.js";
import { getToasts, _resetToasts } from "../state/toastStore.js";

beforeEach(() => _resetToasts());

describe("notify facade", () => {
  it("info/warning/error push a toast with the right severity and return its id", () => {
    const i = notify.info("i");
    const w = notify.warning("w");
    const e = notify.error("e");
    expect([i, w, e]).toEqual([1, 2, 3]);
    expect(getToasts().map((t) => [t.severity, t.message])).toEqual([
      ["info", "i"],
      ["warning", "w"],
      ["error", "e"],
    ]);
  });

  it("forwards opts (title, duration) onto the toast", () => {
    notify.error("Push failed", { title: "Git", duration: 6000 });
    expect(getToasts()[0]).toMatchObject({ title: "Git", duration: 6000 });
  });

  it("dismiss removes a toast by the id it returned", () => {
    const id = notify.info("gone");
    notify.info("stays");
    notify.dismiss(id);
    expect(getToasts().map((t) => t.message)).toEqual(["stays"]);
  });

  it("clear empties the list", () => {
    notify.info("a");
    notify.warning("b");
    notify.clear();
    expect(getToasts()).toEqual([]);
  });
});
