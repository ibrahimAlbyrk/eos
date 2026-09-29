// How each provider looks in the Accounts surfaces. The daemon owns account
// STATE (/api/accounts); the UI owns names, makers and plan wording. An id the
// table doesn't know falls back to the daemon's label.

export const PROVIDER_META = {
  anthropic: { name: "Claude", maker: "Anthropic", plans: "Pro or Max", signIn: "Sign in with Claude", cta: "Continue with Claude" },
  openai: { name: "ChatGPT", maker: "OpenAI · Codex", plans: "Plus or Pro", signIn: "Sign in with ChatGPT", cta: "Continue with ChatGPT" },
  gemini: { name: "Gemini", maker: "Google", plans: "Google account", signIn: "Sign in with Google", cta: "Continue with Google" },
  xai: { name: "xAI Grok" },
  deepseek: { name: "DeepSeek" },
  moonshot: { name: "Moonshot Kimi" },
  qwen: { name: "Alibaba Qwen" },
  zhipu: { name: "Zhipu GLM" },
};

export function metaFor(account) {
  return PROVIDER_META[account.id] ?? { name: account.label };
}

const PLAN_NAMES = { prolite: "Pro Lite" };

// "max" → "Max plan"; no plan recorded → null.
export function planName(plan) {
  if (!plan) return null;
  return `${PLAN_NAMES[plan] ?? `${plan[0].toUpperCase()}${plan.slice(1)}`} plan`;
}


export function keyHint(account) {
  return account.apiKey.hint ? `••••${account.apiKey.hint}` : "Key saved";
}

// The subscription lane each account runs on, by backend kind — how a picker
// choice for a subscription lane (a bare kind) finds its account.
const SUBSCRIPTION_LANE_ACCOUNT = { claude: "anthropic", "codex-cli": "openai", "gemini-cli": "gemini" };
// Lanes that also run on the account's API key while signed out (the claude
// binary takes ANTHROPIC_API_KEY). A Codex or Gemini CLI session runs only on the
// plan — the key is served by the account's API profile instead.
const LANES_TAKING_KEYS = new Set(["claude"]);

// Whether a composer provider choice (lib/backendCaps.providerChoices) is this
// account: a subscription lane by its kind, an API profile by its name.
export function accountMatchesChoice(account, choice) {
  return choice.subscription
    ? SUBSCRIPTION_LANE_ACCOUNT[choice.kind] === account.id
    : Boolean(account.profile) && choice.name === account.profile;
}

// Can this choice run on its account right now? A plan lane needs the sign-in (or,
// for a lane that takes keys, the key); an API profile exists only with its key.
export function choiceReady(choice, account) {
  if (!choice.subscription) return true;
  return account.route === "subscription" || (LANES_TAKING_KEYS.has(choice.kind) && account.route === "api_key");
}
