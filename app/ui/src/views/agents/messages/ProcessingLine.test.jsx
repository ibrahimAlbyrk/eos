import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProcessingLine } from "./ProcessingLine.jsx";
import { GoalCheckLine } from "./LoopCheck.jsx";

describe("activity line star", () => {
  it("busy: star with 8 rays, working label and elapsed", () => {
    const html = renderToStaticMarkup(<ProcessingLine busy elapsed="0:42" />);
    expect(html).toContain('class="activity-line is-busy"');
    expect(html).toContain('class="al-spin"');
    expect(html.match(/class="al-ray"/g)).toHaveLength(8);
    expect(html).toContain("working");
    expect(html).toContain("0:42");
  });

  it("idle on mount: grey star only, no settle", () => {
    const html = renderToStaticMarkup(<ProcessingLine busy={false} elapsed={null} />);
    expect(html).toContain('class="activity-line"');
    expect(html).toContain('class="al-star"');
    expect(html).not.toContain("working");
  });

  it("goal check uses the same star", () => {
    const check = { startedAt: 0, attempt: 2, maxAttempts: 5, phase: "judging" };
    const html = renderToStaticMarkup(<GoalCheckLine check={check} now={8000} />);
    expect(html).toContain("activity-line is-check");
    expect(html).toContain('class="al-star"');
    expect(html).toContain("0:08");
  });
});
