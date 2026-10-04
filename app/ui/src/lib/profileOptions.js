// The choices the profile offers — one table, shared by Settings › Profile and the
// first-run interview. A new option is a row here (the daemon's renderer has the
// matching phrase in core/src/services/render-user-profile.ts).

export const ROLE_OPTIONS = [
  { value: "engineering", label: "Engineering" },
  { value: "design", label: "Design" },
  { value: "product", label: "Product" },
  { value: "research", label: "Research" },
  { value: "data", label: "Data" },
  { value: "writing", label: "Writing" },
];

export const LEVEL_OPTIONS = [
  { value: "learning", label: "Learning" },
  { value: "practitioner", label: "Practitioner" },
  { value: "expert", label: "Expert" },
];

export const REPLY_OPTIONS = [
  { value: "terse", label: "Terse" },
  { value: "balanced", label: "Balanced" },
  { value: "thorough", label: "Thorough" },
];

export const AUTONOMY_OPTIONS = [
  { value: "ask", label: "Ask first" },
  { value: "balanced", label: "Balanced" },
  { value: "run", label: "Run with it" },
];

export const UNCLEAR_OPTIONS = [
  { value: "ask", label: "Ask me" },
  { value: "decide", label: "Decide, tell me after" },
];

export const COMMIT_OPTIONS = [
  { value: "on-request", label: "Only when I ask" },
  { value: "milestones", label: "At milestones" },
];

// Native names: the user picks their own language the way they'd write it.
export const LANGUAGE_OPTIONS = [
  { value: "tr", label: "Türkçe" },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
];

export const CHAT_LANGUAGE_OPTIONS = [...LANGUAGE_OPTIONS, { value: "mirror", label: "Mirror me" }];

// Who receives the profile, grouped the way the user thinks about it. Each target
// toggles its backend kinds in profile.sharing.withholdFrom.
export const SHARE_TARGETS = [
  { id: "claude", label: "Claude agents", kinds: ["claude", "anthropic-api"] },
  { id: "codex", label: "Codex agents", kinds: ["codex-cli", "codex"] },
  { id: "gemini", label: "Gemini agents", kinds: ["gemini-cli"] },
  { id: "api", label: "Other API models", kinds: ["openai"] },
];
