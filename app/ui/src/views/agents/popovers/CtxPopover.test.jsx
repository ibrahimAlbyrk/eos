import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanUsageLimits } from "./CtxPopover.jsx";

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

const render = (props) => renderToStaticMarkup(<PlanUsageLimits {...props} />);

describe("PlanUsageLimits", () => {
  it("renders a row per window from mock usage, with plan name and warn tint ≥80%", () => {
    const html = render({ usage: fullUsage, onOpenSettings: () => {} });
    expect(html).toContain("Plan usage limits · Max");
    expect(html).toContain("5-hour limit");
    expect(html).toContain("all models");
    expect(html).toContain("Opus");
    expect(html).toContain("Sonnet");
    // Bars reflect utilization; only the ≥80% (Opus) bar gets the warn tint.
    expect(html).toContain("width:42%");
    expect(html).toContain("width:85%");
    expect(html).toContain("var(--warn)");
    // Chevron wired to the Usage settings pane.
    expect(html).toContain('aria-label="Open Usage settings"');
  });

  it("omits the chevron when no navigation helper is available", () => {
    const html = render({ usage: fullUsage });
    expect(html).toContain("Plan usage limits");
    expect(html).not.toContain('aria-label="Open Usage settings"');
  });

  it("renders nothing while loading, on error, or with no windows", () => {
    expect(render({ usage: undefined })).toBe(""); // loading
    expect(render({ usage: null })).toBe(""); // transport fail
    expect(render({ usage: { providers: [], errors: [{ reason: "no subscription token" }] } })).toBe("");
    expect(render({ usage: { providers: [{ provider: "claude", windows: {} }] } })).toBe("");
  });
});
