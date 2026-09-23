import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelShell } from "./PanelShell.jsx";

// PanelShell is now a thin island wrapper: the tab bar / fullscreen / close live
// on the parent SidePanel, so the shell only renders the type-scoped surface plus
// an optional header when a viewer passes its own title/actions.
function render(props = {}, children = null) {
  return renderToStaticMarkup(<PanelShell type="review" {...props}>{children}</PanelShell>);
}

describe("PanelShell", () => {
  it("renders the type-scoped island with no header when no title/actions", () => {
    const html = render({}, <div className="my-body" />);
    expect(html).toContain("panel-shell--review");
    expect(html).toContain("my-body");
    expect(html).not.toContain("panel-shell__head");
  });

  it("renders a node title inside the header title slot", () => {
    const html = render({ title: <span className="my-crumb">repo · main</span> });
    expect(html).toContain("panel-shell__head");
    expect(html).toContain("panel-shell__title");
    expect(html).toContain("my-crumb");
  });

  it("puts viewer actions in the header and the body in the island", () => {
    const html = render({ actions: <button className="my-action">act</button> }, <div className="my-body" />);
    const head = html.slice(html.indexOf("panel-shell__head"), html.indexOf("my-body"));
    expect(head).toContain("my-action");
  });
});
