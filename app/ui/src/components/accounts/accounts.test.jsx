import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountCard } from "./AccountCard.jsx";
import { accountMatchesChoice, choiceReady, planName } from "./providerMeta.js";
import { _resetAccounts } from "../../state/accountsStore.js";

const claude = (over = {}) => ({
  id: "anthropic",
  label: "Claude",
  subscription: { supported: true, state: "signed_out" },
  apiKey: { set: false },
  route: "none",
  ...over,
});
const openai = (over = {}) => ({
  id: "openai",
  label: "OpenAI",
  subscription: { supported: false, state: "signed_out" },
  apiKey: { set: false },
  route: "none",
  ...over,
});

const gemini = (over = {}) => ({
  id: "gemini",
  label: "Gemini",
  subscription: { supported: true, state: "signed_in", source: "eos" },
  apiKey: { set: false },
  route: "subscription",
  ...over,
});

const card = (account) => renderToStaticMarkup(<AccountCard account={account} />);

beforeEach(() => _resetAccounts());

describe("AccountCard", () => {
  it("not connected + sign-in supported: sign in first, the key as the alternative", () => {
    const html = card(claude());
    expect(html).toContain("Not connected");
    expect(html).toContain("Sign in with Claude");
    expect(html).toContain("Use an API key");
  });

  it("not connected + no plan sign-in yet: the key is the primary action, sign-in marked Soon", () => {
    const html = card(openai());
    expect(html).toContain("Add API key");
    expect(html).toContain("Sign in with ChatGPT · Soon");
    expect(html).not.toContain("Use an API key");
  });

  it("signed in: the plan, where it came from, and the billing order with the key on standby", () => {
    const html = card(claude({
      subscription: { supported: true, state: "signed_in", source: "eos", plan: "max" },
      apiKey: { set: true, hint: "4f2a" },
      route: "subscription",
    }));
    expect(html).toContain("Max plan");
    expect(html).toContain("Signed in through Eos");
    expect(html).toContain("••••4f2a");
    expect(html).toContain("Standby");
    expect(html).toContain("Sign out");
  });

  it("a Google sign-in is Eos's own, and Eos can sign it out", () => {
    const html = card(gemini());
    expect(html).toContain("Signed in through Eos");
    expect(html).toContain("Sign out");
  });

  it("expired: sign in again, and say the key stays unused", () => {
    const html = card(claude({
      subscription: { supported: true, state: "expired", source: "eos" },
      apiKey: { set: true, hint: "4f2a" },
      route: "blocked",
    }));
    expect(html).toContain("Sign-in expired");
    expect(html).toContain("Sign in again");
    expect(html).toContain("stays unused");
  });

  it("API key only: pay per token, with the upgrade path", () => {
    const html = card(claude({ apiKey: { set: true, hint: "9c2e" }, route: "api_key" }));
    expect(html).toContain("Pay per token");
    expect(html).toContain("••••9c2e");
    expect(html).toContain("Sign in with Claude");
    expect(html).toContain("Manage API key");
  });
});

describe("choiceReady — which lane can run on the account now", () => {
  const claudeLane = { name: "claude", kind: "claude", subscription: true };
  const codexLane = { name: "codex-cli", kind: "codex-cli", subscription: true };
  it("a plan lane needs the sign-in; only the claude lane also runs on a key", () => {
    expect(choiceReady(codexLane, openai({ route: "subscription" }))).toBe(true);
    expect(choiceReady(codexLane, openai({ route: "api_key" }))).toBe(false);
    expect(choiceReady(claudeLane, claude({ route: "api_key" }))).toBe(true);
    expect(choiceReady(claudeLane, claude({ route: "blocked" }))).toBe(false);
  });
  it("a Codex lane maps to the ChatGPT account", () => {
    expect(accountMatchesChoice(openai(), codexLane)).toBe(true);
    expect(accountMatchesChoice(claude(), codexLane)).toBe(false);
  });
  it("a Gemini lane maps to the Google account and runs only on its plan", () => {
    const geminiLane = { name: "gemini-cli", kind: "gemini-cli", subscription: true };
    expect(accountMatchesChoice(gemini(), geminiLane)).toBe(true);
    expect(accountMatchesChoice(openai(), geminiLane)).toBe(false);
    expect(choiceReady(geminiLane, gemini())).toBe(true);
    expect(choiceReady(geminiLane, gemini({ route: "api_key" }))).toBe(false);
  });
  it("plan names read naturally", () => {
    expect(planName("prolite")).toBe("Pro Lite plan");
    expect(planName("max")).toBe("Max plan");
  });
});

describe("accountMatchesChoice", () => {
  it("a subscription lane matches its account by kind; a profile by name", () => {
    expect(accountMatchesChoice(claude(), { name: "claude", kind: "claude", subscription: true })).toBe(true);
    expect(accountMatchesChoice(openai({ profile: "openai" }), { name: "openai", kind: "openai", subscription: false })).toBe(true);
    expect(accountMatchesChoice(openai(), { name: "openai", kind: "openai", subscription: false })).toBe(false);
    expect(accountMatchesChoice(openai({ profile: "openai" }), { name: "claude", kind: "claude", subscription: true })).toBe(false);
  });
});
