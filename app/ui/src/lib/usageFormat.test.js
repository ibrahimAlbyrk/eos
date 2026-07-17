import { describe, it, expect } from "vitest";
import { planUsageRows, formatResetIn, formatResetAt, WARN_THRESHOLD, friendlyUsageError } from "./usageFormat.js";

const win = (utilization, resetsAt = "2099-01-01T08:59:00Z") => ({ utilization, resetsAt });

const fullUsage = {
  providers: [
    {
      provider: "claude",
      plan: "Max",
      windows: {
        fiveHour: win(42),
        sevenDay: win(10),
        sevenDayOpus: win(85),
        sevenDaySonnet: win(3),
      },
      fetchedAt: "2099-01-01T00:00:00Z",
    },
  ],
  errors: [],
};

describe("planUsageRows", () => {
  it("derives one row per non-null window, in order, with plan + kind", () => {
    const section = planUsageRows(fullUsage);
    expect(section.plan).toBe("Max");
    expect(section.rows.map((r) => [r.key, r.label, r.kind])).toEqual([
      ["fiveHour", "5-hour limit", "session"],
      ["sevenDay", "Weekly · all models", "weekly"],
      ["sevenDayOpus", "Weekly · Opus", "weekly"],
      ["sevenDaySonnet", "Weekly · Sonnet", "weekly"],
    ]);
    expect(section.rows[2].window.utilization).toBe(85);
  });

  it("skips null windows (only the present ones render)", () => {
    const section = planUsageRows({
      providers: [{ provider: "claude", windows: { fiveHour: win(20), sevenDayOpus: win(50) } }],
    });
    expect(section.rows.map((r) => r.key)).toEqual(["fiveHour", "sevenDayOpus"]);
  });

  it("carries a null plan through when the provider has none", () => {
    const section = planUsageRows({ providers: [{ provider: "claude", windows: { fiveHour: win(1) } }] });
    expect(section.plan).toBeNull();
  });

  it("hides (null) on empty, error, or no-window responses", () => {
    expect(planUsageRows(null)).toBeNull(); // loading / transport fail
    expect(planUsageRows(undefined)).toBeNull();
    expect(planUsageRows({ providers: [], errors: [{ reason: "no subscription token" }] })).toBeNull();
    expect(planUsageRows({ providers: [{ provider: "claude", windows: {} }] })).toBeNull();
  });
});

describe("friendlyUsageError", () => {
  it("maps the user:profile scope error to a re-login hint (no raw JSON)", () => {
    const raw =
      'usage fetch failed (HTTP 403): {"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}}';
    const msg = friendlyUsageError(raw);
    expect(msg).toMatch(/user:profile/);
    expect(msg).toMatch(/claude \/login/);
    expect(msg).not.toMatch(/[{}]/); // never leaks the JSON body
  });

  it("collapses a generic reason to a one-liner without the raw dump", () => {
    const msg = friendlyUsageError('usage fetch failed (HTTP 500): {"error":"boom"}');
    expect(msg).toBe("Couldn’t load usage right now. Please try again in a moment.");
    expect(msg).not.toMatch(/[{}]/);
    expect(msg).not.toMatch(/500/);
  });

  it("falls back to the generic one-liner when the reason is missing", () => {
    expect(friendlyUsageError(undefined)).toBe("Couldn’t load usage right now. Please try again in a moment.");
  });
});

describe("reset formatters", () => {
  it("formatResetIn is relative hours/minutes", () => {
    const in2h = new Date(Date.now() + (2 * 60 + 3) * 60000).toISOString();
    expect(formatResetIn(in2h)).toBe("2 hr 3 min");
    expect(formatResetIn(new Date(Date.now() - 1000).toISOString())).toBe("now");
  });

  it("formatResetAt is weekday + local time", () => {
    // Sunday in any locale/zone → starts with a 3-letter weekday abbreviation.
    expect(formatResetAt("2099-01-04T09:00:00Z")).toMatch(/^[A-Za-z]{3}\s/);
  });

  it("WARN_THRESHOLD is the shared 80% tint boundary", () => {
    expect(WARN_THRESHOLD).toBe(80);
  });
});
