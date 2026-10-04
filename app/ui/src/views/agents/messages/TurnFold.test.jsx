import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { TurnFold } from "./TurnFold.jsx";

// UiProvider's stores read localStorage; the node test env has none.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const fold = (durationMs) => ({
  key: "fold-t-1",
  runKey: "t-1",
  work: [{ kind: "tool", tool: { id: "1", name: "Read", input: {} } }],
  durationMs,
});
const render = (f) => renderToStaticMarkup(
  <UiProvider><TurnFold fold={f} settle={false} renderStep={() => <p>step</p>} /></UiProvider>,
);

// No jsdom here: this pins the resting fold — one row and the rule, nothing of
// the work mounted until the row is opened.
describe("TurnFold", () => {
  it("rests as the worked-for row over a rule, its steps unmounted", () => {
    const html = render(fold(252000));
    expect(html).toContain("Worked for 4m 12s");
    expect(html).toContain('class="turn-fold is-rest"');
    expect(html).toContain('class="turn-fold-rule"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("step");
  });

  it("says only 'Worked' when the turn has no timing", () => {
    expect(render(fold(null))).toContain("<span>Worked</span>");
  });
});
