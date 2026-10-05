import { describe, it, expect } from "vitest";
import {
  planUsageSections, isSignedOutReason, formatResetIn, formatResetInShort, formatResetAt, formatRowReset, formatCredits,
  isUsageWarn, WARN_THRESHOLD, friendlyUsageError,
} from "./usageFormat.js";

const win = (utilization, resetsAt = "2099-01-01T08:59:00Z") => ({ utilization, resetsAt });

const fullUsage = {
  providers: [
    {
      provider: "claude",
      plan: "Max",
      windows: {
        fiveHour: win(42),
        sevenDay: win(10),
        weeklyByModel: [{ ...win(85), model: "Fable" }],
      },
      fetchedAt: "2099-01-01T00:00:00Z",
    },
  ],
  errors: [],
};

describe("planUsageSections", () => {
  it("derives one row per non-null window, in order, then one per model's weekly limit", () => {
    const [section] = planUsageSections(fullUsage);
    expect(section).toMatchObject({ provider: "claude", name: "Claude", plan: "Max" });
    expect(section.rows.map((r) => [r.key, r.label, r.short, r.kind])).toEqual([
      ["fiveHour", "5-hour limit", "5-hour", "session"],
      ["sevenDay", "Weekly · all models", "Weekly", "weekly"],
      ["model:Fable", "Weekly · Fable", "Weekly Fable", "weekly"],
    ]);
    expect(section.rows[2].window.utilization).toBe(85);
  });

  it("one section per signed-in plan — Claude and ChatGPT side by side", () => {
    const sections = planUsageSections({
      providers: [
        fullUsage.providers[0],
        { provider: "codex", plan: "Pro Lite", windows: { fiveHour: null, sevenDay: win(39) }, fetchedAt: "x" },
      ],
    });
    expect(sections.map((s) => [s.name, s.plan, s.rows.map((r) => r.key)])).toEqual([
      ["Claude", "Max", ["fiveHour", "sevenDay", "model:Fable"]],
      ["ChatGPT", "Pro Lite", ["sevenDay"]],
    ]);
  });

  it("skips null windows and carries a null plan through", () => {
    const [section] = planUsageSections({ providers: [{ provider: "claude", windows: { fiveHour: null, sevenDay: win(50) } }] });
    expect(section.rows.map((r) => r.key)).toEqual(["sevenDay"]);
    expect(section.plan).toBeNull();
  });

  it("is empty on loading, error, or no-window responses", () => {
    expect(planUsageSections(null)).toEqual([]);
    expect(planUsageSections(undefined)).toEqual([]);
    expect(planUsageSections({ providers: [], errors: [{ reason: "no subscription token" }] })).toEqual([]);
    expect(planUsageSections({ providers: [{ provider: "claude", windows: {} }] })).toEqual([]);
  });
});

describe("isSignedOutReason", () => {
  it("treats not-signed-in reasons as nothing to show, real failures as errors", () => {
    expect(isSignedOutReason("No Claude subscription token configured.")).toBe(true);
    expect(isSignedOutReason("Not signed in to ChatGPT.")).toBe(true);
    expect(isSignedOutReason("usage fetch failed (HTTP 500)")).toBe(false);
  });
});

describe("friendlyUsageError", () => {
  it("maps the user:profile scope error to a re-login hint (no raw JSON)", () => {
    const raw =
      'usage fetch failed (HTTP 403): {"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}}';
    const msg = friendlyUsageError(raw);
    expect(msg).toMatch(/sign in again/);
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

  it("formatResetInShort is the compact h/m form", () => {
    const at = (min) => new Date(Date.now() + min * 60000).toISOString();
    expect(formatResetInShort(at(2 * 60 + 15))).toBe("2h 15m");
    expect(formatResetInShort(at(3 * 60))).toBe("3h");
    expect(formatResetInShort(at(45))).toBe("45m");
  });

  it("formatResetAt is weekday + local time", () => {
    // Sunday in any locale/zone → starts with a 3-letter weekday abbreviation.
    expect(formatResetAt("2099-01-04T09:00:00Z")).toMatch(/^[A-Za-z]{3}\s/);
  });

  it("WARN_THRESHOLD is the shared 80% tint boundary", () => {
    expect(WARN_THRESHOLD).toBe(80);
  });

  it("formatRowReset says 'Not started' for a window with no reset yet", () => {
    const session = { kind: "session", window: { utilization: 0, resetsAt: null } };
    expect(formatRowReset(session)).toBe("Not started");
    expect(formatRowReset(session, { short: true })).toBe("not started");
    const weekly = { kind: "weekly", window: win(10, "2099-01-04T09:00:00Z") };
    expect(formatRowReset(weekly)).toBe(`Resets ${formatResetAt("2099-01-04T09:00:00Z")}`);
  });
});

describe("isUsageWarn", () => {
  it("follows the provider's severity when it reports one", () => {
    expect(isUsageWarn({ utilization: 96, severity: "normal" })).toBe(false);
    expect(isUsageWarn({ utilization: 60, severity: "warning" })).toBe(true);
  });

  it("falls back to the 80% line without a severity", () => {
    expect(isUsageWarn(win(79))).toBe(false);
    expect(isUsageWarn(win(80))).toBe(true);
  });
});

describe("formatCredits", () => {
  it("formats amounts in the plan's currency", () => {
    expect(formatCredits(12.34, "USD")).toMatch(/12[.,]34/);
    expect(formatCredits(12.34, "USD")).toMatch(/\$|USD/);
  });
});
