import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountCard } from "./AccountCard.jsx";
import { PlanLoginsCard } from "./PlanLoginsCard.jsx";
import { accountMatchesChoice, choiceReady, planName, planLabel } from "./providerMeta.js";
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

describe("PlanLoginsCard", () => {
  const login = (id, over = {}) => ({ id, label: `${id}@example.com`, email: `${id}@example.com`, plan: "max", state: "signed_in", ...over });
  const listed = (logins, defaultLoginId = logins[0]?.id) =>
    renderToStaticMarkup(<PlanLoginsCard account={claude({ route: "subscription", logins, defaultLoginId })} />);

  it("one row per sign-in with its plan; the email only when the name isn't it", () => {
    const html = listed([login("me"), login("work", { label: "Work", plan: "pro" })]);
    expect(html).toContain("2 accounts");
    expect(html).toContain("me@example.com");
    expect(html).toContain("Work");
    expect(html).toContain("work@example.com");
    expect(html).toContain(">Max<");
    expect(html).toContain(">Pro<");
    expect(html).toContain("Add account");
    expect(listed([login("me")]).match(/me@example\.com/g)).toHaveLength(1);
  });

  it("the default account and auto-switch are offered only once there are two", () => {
    expect(listed([login("me")])).not.toContain("Default account");
    expect(listed([login("me")])).not.toContain("Switch automatically");
    const two = listed([login("me"), login("work")], "work");
    expect(two).toContain("Default account");
    expect(two).toContain("Switch automatically");
    expect(two).toContain('aria-checked="true"');
  });

  it("a sign-in at its limit says until when", () => {
    const at = new Date(2026, 9, 28, 16, 40).toISOString();
    expect(listed([login("me", { limitedUntil: at })])).toContain("At limit · resets");
  });

  it("a sign-in that stopped working offers to sign in again", () => {
    const html = listed([login("me", { state: "signed_out" })]);
    expect(html).toContain("Signed out");
    expect(html).toContain("Sign in again");
  });

  it("plan labels drop the word plan", () => {
    expect(planLabel("prolite")).toBe("Pro Lite");
    expect(planLabel(undefined)).toBe(null);
  });
});
