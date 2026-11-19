import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { _resetRunSheet, close, open, registerHost, useRunSheet } from "./runSheetStore.js";

function current() {
  let read;
  function Probe() {
    read = useRunSheet();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

beforeEach(() => _resetRunSheet());

describe("the run sheet's requests", () => {
  it("go nowhere while no sheet is hosted", () => {
    open({ routineId: "rt-1", anchor: null });
    expect(current()).toEqual({ hosted: 0, request: null });
  });

  it("reach a hosted sheet, and close", () => {
    const unregister = registerHost();
    const anchor = { id: "button" };
    open({ routineId: "rt-1", anchor });
    expect(current()).toEqual({ hosted: 1, request: { routineId: "rt-1", anchor } });
    close();
    expect(current().request).toBeNull();
    unregister();
    expect(current().hosted).toBe(0);
  });

  it("are dropped when the last host goes, and a host unregisters once", () => {
    const first = registerHost();
    const second = registerHost();
    open({ routineId: "rt-1", anchor: null });
    first();
    first();
    expect(current()).toMatchObject({ hosted: 1, request: { routineId: "rt-1" } });
    second();
    expect(current()).toEqual({ hosted: 0, request: null });
  });
});
