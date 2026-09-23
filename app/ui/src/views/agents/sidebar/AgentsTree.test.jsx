import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentsTree } from "./AgentsTree.jsx";

// Regression: before the first /workers fetch resolves (loaded=false) an empty
// list must render as loading, not as the definitive "No agents yet" — a
// hanging or failed initial fetch used to read as zero agents existing.
describe("AgentsTree empty state", () => {
  it("shows loading, not 'No agents yet', while the workers list is unloaded", () => {
    const html = renderToStaticMarkup(<AgentsTree roots={[]} loaded={false} />);
    expect(html).not.toContain("No agents yet");
    expect(html).toContain("Loading agents");
  });

  it("shows 'No agents yet' only once loaded with a truly empty list", () => {
    const html = renderToStaticMarkup(<AgentsTree roots={[]} loaded={true} />);
    expect(html).toContain("No agents yet");
  });
});
