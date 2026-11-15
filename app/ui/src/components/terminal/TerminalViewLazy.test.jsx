import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalView } from "./TerminalViewLazy.jsx";

// Before the chunk is in (or after it failed), a terminal is the empty host, never
// a thrown render that would reach the app-level boundary.
describe("TerminalView before its chunk loads", () => {
  it("renders the empty host, shown or hidden as the terminal would be", () => {
    expect(renderToStaticMarkup(<TerminalView active />)).toBe('<div class="pty-view" style="display:block"></div>');
    expect(renderToStaticMarkup(<TerminalView active visible={false} />)).toBe('<div class="pty-view" style="display:none"></div>');
  });
});
