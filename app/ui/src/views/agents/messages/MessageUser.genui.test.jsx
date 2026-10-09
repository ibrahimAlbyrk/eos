import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewReplyChip } from "./MessageUser.jsx";

describe("view action reply chip", () => {
  it("names the view it came from and the action label", () => {
    const html = renderToStaticMarkup(
      <ViewReplyChip action={{ viewId: "v_abcdefghijkl", label: "Fix all 3 with a worker", viewTitle: "manager · test run" }} text="Fix all 3 with a worker" />,
    );
    expect(html).toContain('class="gv-reply"');
    expect(html).toContain('<span class="gv-reply-view">manager · test run</span>');
    expect(html).toContain('<span class="gv-reply-label">Fix all 3 with a worker</span>');
    expect(html).toContain("Go to “manager · test run”");
  });

  it("falls back to the message text when the label is missing", () => {
    const html = renderToStaticMarkup(<ViewReplyChip action={{ viewId: "v_abcdefghijkl" }} text="Re-run failed (5)" />);
    expect(html).toContain("Re-run failed (5)");
    expect(html).not.toContain("gv-reply-view");
  });
});
