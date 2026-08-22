import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Toast } from "./Toast.jsx";

// No jsdom in this suite, so we assert the rendered markup (SSR) rather than
// dispatch clicks: the affordance's presence and its label. The onClick→dismiss
// wiring is exercised where it matters, in browserSessionState.test.js.
const base = {
  id: 1, severity: "info", message: "Agent is presenting a page — click to view.",
  title: undefined, duration: 3000, dismissible: true, leaving: false,
};

describe("Toast action affordance", () => {
  it("renders a clickable action button carrying the label when an action is present", () => {
    const html = renderToStaticMarkup(<Toast {...base} action={{ label: "View", onClick: () => {} }} />);
    expect(html).toContain('class="toast__action"');
    expect(html).toContain(">View<");
  });

  it("renders no action affordance when no action is given (backward compat)", () => {
    const html = renderToStaticMarkup(<Toast {...base} action={null} />);
    expect(html).not.toContain("toast__action");
    // The plain card still renders its message and close button as before.
    expect(html).toContain("toast__msg");
    expect(html).toContain("toast__close");
  });
});
