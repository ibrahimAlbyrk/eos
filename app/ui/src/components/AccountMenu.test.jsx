import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanUsage } from "./AccountMenu.jsx";

const win = (utilization, resetsAt = "2099-01-01T08:59:00Z") => ({ utilization, resetsAt });

const fullUsage = {
  providers: [
    {
      provider: "claude",
      plan: "Max",
      windows: { fiveHour: win(42), sevenDay: win(10), sevenDayOpus: win(85), sevenDaySonnet: win(3) },
      fetchedAt: "2099-01-01T00:00:00Z",
    },
  ],
  errors: [],
};

const render = (props) => renderToStaticMarkup(<PlanUsage {...props} />);

describe("PlanUsage", () => {
  it("renders a row per window from mock usage, with plan name and warn tint ≥80%", () => {
    const html = render({ usage: fullUsage });
    expect(html).toContain("Plan usage");
    expect(html).toContain(">Max<");
    expect(html).toContain("5-hour limit");
    expect(html).toContain("all models");
    expect(html).toContain("Opus");
    expect(html).toContain("Sonnet");
    // Meters reflect utilization; only the ≥80% (Opus) row gets the warn tint.
    expect(html).toContain("width:42%");
    expect(html).toContain("width:85%");
    expect(html.match(/usage-meter is-warn/g)).toHaveLength(1);
  });

  it("renders nothing while loading, on error, or with no windows", () => {
    expect(render({ usage: undefined })).toBe(""); // loading
    expect(render({ usage: null })).toBe(""); // transport fail
    expect(render({ usage: { providers: [], errors: [{ reason: "no subscription token" }] } })).toBe("");
    expect(render({ usage: { providers: [{ provider: "claude", windows: {} }] } })).toBe("");
  });
});
