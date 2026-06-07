// Settings registry — the single place sections and their items live.
// SettingsSection contract (documented, not enforced — plain objects):
//   { id, label, Icon, groups: [{ title, items: [SettingItem] }] }
// SettingItem:
//   { key, label, description?, control: { type, ...props }, defaultValue,
//     visibleWhen?: (settings) => bool }   // conditional rows (e.g. mode-dependent)
//
// The modal, controls and persistence never change when settings are added
// (Open/Closed): a new setting is a registry entry, a new control type is one
// entry in controls.jsx CONTROLS. A section may provide `Component` instead
// of `groups` to render fully custom content.

import { MODELS } from "../lib/models.js";

// Providers carry their kind ("cli" | "api") so dependent rows (API key)
// derive visibility from the data, not from provider-name checks. API
// providers stay disabled until their backends are wired.
const PROVIDERS = [
  { value: "claude-cli", label: "Claude Code CLI", kind: "cli" },
  { value: "anthropic-api", label: "Anthropic API", kind: "api", hint: "Soon", disabled: true },
  { value: "openai", label: "OpenAI API", kind: "api", hint: "Soon", disabled: true },
];

const isApiProvider = (s) =>
  PROVIDERS.find((p) => p.value === s["model.provider"])?.kind === "api";

const GeneralIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const SystemThemeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

const LightThemeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

const DarkThemeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const CodeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
  </svg>
);

const ModelIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </svg>
);

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    Icon: GeneralIcon,
    groups: [
      {
        title: "Preferences",
        items: [
          {
            key: "appearance.theme",
            label: "Appearance",
            description: "System follows the macOS appearance.",
            control: {
              type: "segmented",
              options: [
                { value: "system", label: "System", Icon: SystemThemeIcon },
                { value: "light", label: "Light", Icon: LightThemeIcon },
                { value: "dark", label: "Dark", Icon: DarkThemeIcon },
              ],
            },
            defaultValue: "system",
          },
        ],
      },
    ],
  },
  {
    id: "model",
    label: "Model",
    Icon: ModelIcon,
    groups: [
      {
        title: "Provider",
        items: [
          {
            key: "model.provider",
            label: "Provider",
            description: "Runtime new agents launch on. API providers are coming soon.",
            control: { type: "select", options: PROVIDERS },
            defaultValue: "claude-cli",
          },
          {
            key: "model.apiKey",
            label: "API key",
            description: "Used only for the selected provider.",
            control: { type: "text", secret: true, placeholder: "sk-…" },
            defaultValue: "",
            visibleWhen: isApiProvider,
          },
        ],
      },
      {
        title: "Model",
        items: [
          {
            key: "model.default",
            label: "Default model",
            description: "New agents spawn with this model.",
            control: {
              type: "select",
              // Getter: re-evaluated on every render spread, so the list stays
              // in sync after applyCatalog() replaces MODELS at runtime.
              get options() {
                return MODELS.map((m) => ({ value: m.aliases[0] ?? m.id, label: m.name, hint: m.tag }));
              },
            },
            defaultValue: "opus",
          },
        ],
      },
    ],
  },
  {
    id: "code",
    label: "Code",
    Icon: CodeIcon,
    groups: [
      {
        title: "Verbose",
        items: [
          {
            key: "verbose.enabled",
            label: "Verbose mode",
            description: "Expand tool call details in the transcript instead of collapsing them.",
            control: { type: "toggle" },
            defaultValue: false,
          },
          {
            key: "verbose.mode",
            label: "Mode",
            description: "Which tool calls verbose mode expands.",
            control: {
              type: "select",
              options: [
                { value: "expanded", label: "All expanded" },
                { value: "selectedExpanded", label: "Only selected expanded" },
                { value: "selectedCollapsed", label: "Only selected collapsed" },
              ],
            },
            defaultValue: "expanded",
            visibleWhen: (s) => !!s["verbose.enabled"],
          },
          {
            key: "verbose.tools",
            label: "Selected tools",
            description: "Tools the mode above applies to.",
            control: {
              type: "toolPicker",
              layout: "stack",
              tools: ["Read", "Bash", "Edit", "Write", "Glob", "Grep", "Skill", "AskUserQuestion", "WebFetch", "WebSearch"],
            },
            defaultValue: [],
            visibleWhen: (s) => !!s["verbose.enabled"] && (s["verbose.mode"] ?? "expanded") !== "expanded",
          },
        ],
      },
    ],
  },
];

export const SETTING_DEFAULTS = Object.fromEntries(
  SETTINGS_SECTIONS
    .flatMap((s) => s.groups ?? [])
    .flatMap((g) => g.items)
    .map((i) => [i.key, i.defaultValue]),
);
