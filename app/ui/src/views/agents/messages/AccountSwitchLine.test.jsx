import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountSwitchLine, accountSwitchReason } from "./AccountSwitchLine.jsx";

describe("AccountSwitchLine", () => {
  it("names the sign-in it continued on and why the last one stopped", () => {
    const html = renderToStaticMarkup(<AccountSwitchLine block={{ from: "Personal", to: "Work", reason: "limit", resetsAt: null }} />);
    expect(html).toContain("Continued on <b>Work</b>");
    expect(html).toContain("Personal reached its limit");
    expect(accountSwitchReason({ from: "Personal", reason: "expired" })).toBe("Personal needs to sign in again");
    expect(accountSwitchReason({ from: "Personal", reason: "limit", resetsAt: new Date(2026, 9, 28, 16, 40).toISOString() })).toMatch(/^Personal resets /);
    expect(accountSwitchReason({ reason: "reset" })).toBe("its limit reset");
    expect(accountSwitchReason({ reason: "api_key" })).toBe("billed per token");
  });
});
