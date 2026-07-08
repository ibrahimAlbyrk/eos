import { describe, it, expect } from "vitest";
import { registerTerminal, focusedTerminalFor } from "./terminalBridge.js";

// Fake host: contains(el) is true only for its own textarea, mirroring how
// document.activeElement lands inside the focused terminal's DOM subtree.
const fakeTerminal = () => {
  const textarea = {};
  const term = {};
  return { term, host: { contains: (el) => el === textarea }, textarea };
};

describe("terminalBridge", () => {
  it("resolves the terminal whose host contains the active element", () => {
    const a = fakeTerminal();
    const b = fakeTerminal();
    const offA = registerTerminal({ term: a.term, host: a.host });
    const offB = registerTerminal({ term: b.term, host: b.host });

    expect(focusedTerminalFor(a.textarea)).toBe(a.term);
    expect(focusedTerminalFor(b.textarea)).toBe(b.term);
    expect(focusedTerminalFor(null)).toBe(null);
    expect(focusedTerminalFor({})).toBe(null); // focus outside every terminal

    offA();
    expect(focusedTerminalFor(a.textarea)).toBe(null); // unregistered → gone
    offB();
  });
});
