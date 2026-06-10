import { describe, it, expect } from "vitest";
import { scrollDelta } from "./useContentEditableEditor.js";

// box = [100, 300], margin = 8 → visible band [108, 292]
describe("scrollDelta", () => {
  it("returns 0 when the range is within the margin band", () => {
    expect(scrollDelta(150, 170, 100, 300)).toBe(0);
  });

  it("scrolls up (negative) when the range is above the top margin", () => {
    expect(scrollDelta(50, 70, 100, 300)).toBe(-58); // 50 - (100 + 8)
  });

  it("scrolls down (positive) when the range is below the bottom margin", () => {
    expect(scrollDelta(320, 340, 100, 300)).toBe(48); // 340 - (300 - 8)
  });

  it("prioritizes the top edge when a tall range overflows both ends", () => {
    expect(scrollDelta(50, 360, 100, 300)).toBe(-58);
  });

  it("honors a custom margin", () => {
    expect(scrollDelta(95, 110, 100, 300, 0)).toBe(-5); // 95 - 100
  });
});
