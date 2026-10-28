import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountsExhaustedRow, exhaustedText } from "./AccountsExhaustedRow.jsx";

const at = new Date(2026, 9, 28, 16, 40).toISOString();
const row = (over = {}) => renderToStaticMarkup(
  <AccountsExhaustedRow workerId="w1" block={{ rowId: 1, nextResetAt: at, apiKey: false, resumeAt: null, resumed: false, ...over }} />,
);

describe("AccountsExhaustedRow", () => {
  it("offers to resume at the next reset, and the API key only when one is set", () => {
    expect(row()).toContain("Resume at");
    expect(row()).not.toContain("Use API key");
    expect(row({ apiKey: true })).toContain("Use API key");
  });

  it("a scheduled resume can be cancelled; a done one offers nothing", () => {
    const scheduled = row({ resumeAt: at });
    expect(scheduled).toContain("Continuing at");
    expect(scheduled).toContain("Cancel");
    expect(row({ resumed: true })).not.toContain("<button");
  });

  it("with no reset to wait for it sends the user to sign in", () => {
    expect(exhaustedText({ nextResetAt: null })).toMatch(/sign in again/);
    expect(row({ nextResetAt: null })).not.toContain("Resume at");
  });
});
