import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanCards } from "./AccountMenu.jsx";

const win = (utilization, resetsAt = "2099-01-01T08:59:00Z") => ({ utilization, resetsAt });

const account = (id, route, plan) => ({ id, label: id, route, subscription: plan ? { plan } : { state: "signed_in" }, apiKey: { set: false } });

const claudeUsage = {
  provider: "claude",
  plan: "Max",
  windows: { fiveHour: win(42), sevenDay: win(10), sevenDayOpus: win(85), sevenDaySonnet: win(3) },
  fetchedAt: "2099-01-01T00:00:00Z",
};
const codexUsage = { provider: "codex", plan: "Pro Lite", windows: { sevenDay: win(39) }, fetchedAt: "x" };

const render = (props) => renderToStaticMarkup(<PlanCards {...props} />);

describe("PlanCards", () => {
  it("a card per signed-in plan — expired included, API keys and not-connected left out", () => {
    const html = render({
      accounts: [
        account("anthropic", "subscription"),
        account("openai", "api_key"),
        account("gemini", "blocked"),
        account("deepseek", "none"),
      ],
    });
    expect(html.match(/class="acct-card"/g)).toHaveLength(2);
    expect(html).toContain(">Claude<");
    expect(html).toContain(">Gemini<");
    expect(html).not.toContain(">ChatGPT<");
    expect(html).toContain('acct-plan is-expired">Expired<');
  });

  it("a ring per limit showing what's left, warn tint only at ≥80% used", () => {
    const html = render({ accounts: [account("anthropic", "subscription")], usage: { providers: [claudeUsage] } });
    expect(html).toContain(">Max<");
    expect(html.match(/class="acct-ring"/g)).toHaveLength(4);
    expect(html).toContain('58<span class="acct-ring__unit">%</span>'); // 42% used
    expect(html).toContain('15<span class="acct-ring__unit">%</span>'); // 85% used
    expect(html).toContain(">5-hour<");
    expect(html).toContain(">Weekly Opus<");
    expect(html.match(/acct-stat is-warn/g)).toHaveLength(1);
    expect(html).toContain('title="Weekly · Opus · 15% left · Resets ');
  });

  it("matches each usage provider to its account", () => {
    const html = render({
      accounts: [account("anthropic", "subscription"), account("openai", "subscription", "prolite")],
      usage: { providers: [codexUsage] },
    });
    const [claudeCard, chatgptCard] = html.split('class="acct-card"').slice(1);
    expect(claudeCard).not.toContain("acct-ring");
    expect(chatgptCard).toContain(">Pro Lite<");
    expect(chatgptCard).toContain('61<span class="acct-ring__unit">%</span>'); // 39% used
  });

  it("keeps just the header while usage loads, fails, or has no windows", () => {
    const accounts = [account("anthropic", "subscription")];
    for (const usage of [undefined, null, { providers: [{ provider: "claude", windows: {} }] }]) {
      const html = render({ accounts, usage });
      expect(html).toContain(">Subscription<");
      expect(html).not.toContain("acct-card__stats");
    }
    expect(render({ accounts: null })).toBe("");
  });
});
