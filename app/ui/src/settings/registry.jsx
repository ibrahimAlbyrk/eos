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

import { ModelSettings, MODEL_SETTING_DEFAULTS } from "./ModelSettings.jsx";
import { RemoteSettings, REMOTE_SETTING_DEFAULTS } from "./RemoteSettings.jsx";

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

const RemoteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.55a11 11 0 0 1 14 0M8.5 16.1a6 6 0 0 1 7 0M2 8.82a15 15 0 0 1 20 0" />
    <path d="M12 20h.01" />
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
      {
        title: "Notifications",
        items: [
          {
            key: "notifications.sidebarAttention",
            label: "Sidebar activity indicators",
            description:
              "Blue dot and pulsing icon in the sidebar when an agent finishes with new output. Does not affect system notifications the orchestrator sends with notify_user.",
            control: { type: "toggle" },
            defaultValue: true,
          },
          {
            key: "notifications.paneAttention",
            label: "Split pane attention pulse",
            description:
              "Pulse a split-view pane's edge (and show a dot in its header) when its agent finishes with new output while you're focused on another pane. Independent of the sidebar indicators above.",
            control: { type: "toggle" },
            defaultValue: true,
          },
        ],
      },
      {
        // archive.* persists to ~/.eos/config.json (the daemon reads it), not
        // the settings.json store — see the archive branch in state/settings.jsx.
        title: "Archive",
        items: [
          {
            key: "archive.retention",
            label: "Auto-delete archived agents",
            description:
              "Permanently delete agents archived longer than 1 day (Daily), 7 days (Weekly), or 30 days (Monthly). Off keeps archives forever.",
            control: {
              type: "select",
              options: [
                { value: "off", label: "Off" },
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
                { value: "monthly", label: "Monthly" },
              ],
            },
            defaultValue: "off",
          },
          {
            key: "archive.purgeOnAppClose",
            label: "Purge archive when the app closes",
            description:
              "Permanently delete all archived agents every time Eos quits.",
            control: { type: "toggle" },
            defaultValue: false,
          },
          {
            key: "archive.cmdW",
            label: "⌘W action",
            description:
              "What ⌘W does to the selected agent. Archive is reversible from the Archive view; Delete permanently removes the agent and its subtree without asking.",
            control: {
              type: "select",
              options: [
                { value: "archive", label: "Archive" },
                { value: "delete", label: "Delete permanently" },
              ],
            },
            defaultValue: "archive",
          },
        ],
      },
      {
        title: "Confirmations",
        items: [
          {
            key: "confirm.agentDelete",
            label: "Confirm before deleting agents",
            description:
              "Show a confirmation dialog before an agent (and its subtree) is permanently deleted from the menus. Ticking \"Don't ask again\" in the dialog turns this off.",
            control: { type: "toggle" },
            defaultValue: true,
          },
          {
            key: "confirm.archivePurge",
            label: "Confirm before purging archived agents",
            description:
              "Show a confirmation dialog before an archived agent (and its subtree) is permanently deleted from the Archive view. Ticking \"Don't ask again\" in the dialog turns this off.",
            control: { type: "toggle" },
            defaultValue: true,
          },
        ],
      },
    ],
  },
  {
    id: "model",
    label: "Model",
    Icon: ModelIcon,
    // Custom Component: the SAME provider + model picker as the composer (shared
    // providerChoices() + useProviderModels()). Owns model.provider + model.default.
    Component: ModelSettings,
  },
  {
    id: "remote",
    label: "Remote",
    Icon: RemoteIcon,
    // Custom Component: the iOS remote-access toggle + pairing QR. Drives the
    // manager remote routes directly (config write → arm → pair); owns no
    // settings.json keys (config.remote lives in config.json).
    Component: RemoteSettings,
  },
  {
    id: "code",
    label: "Code",
    Icon: CodeIcon,
    groups: [
      {
        title: "Git",
        items: [
          {
            key: "git.autoApplyOnReport",
            label: "Auto-apply worker changes",
            description: "When a worker reports done, its worktree changes land in your checkout as unstaged edits — test immediately, then Keep or Discard. Off = apply manually from the Changes panel.",
            control: { type: "toggle" },
            defaultValue: false,
          },
          {
            key: "git.spawnWithoutWorktree",
            label: "Spawn workers without worktrees",
            description: "Workers run directly in the orchestrator's checkout — edits land in your files immediately, but parallel workers can conflict. Off = each worker gets an isolated git worktree.",
            control: { type: "toggle" },
            defaultValue: false,
          },
          {
            key: "git.carryUncommitted",
            label: "Carry uncommitted changes into new worktrees",
            description: "When a worker gets an isolated worktree, seed it with the source checkout's uncommitted work (modified, staged, and untracked files) so the agent starts from your work-in-progress. Off = the worktree forks clean from the last commit.",
            control: { type: "toggle" },
            defaultValue: false,
          },
        ],
      },
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
            key: "verbose.groupExpanded",
            label: "Expand tool groups",
            description: "Start grouped tool calls expanded instead of collapsed.",
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

export const SETTING_DEFAULTS = {
  ...Object.fromEntries(
    SETTINGS_SECTIONS
      .flatMap((s) => s.groups ?? [])
      .flatMap((g) => g.items)
      .map((i) => [i.key, i.defaultValue]),
  ),
  // The model section is a custom Component (no groups items), so its keys'
  // defaults are merged in explicitly.
  ...MODEL_SETTING_DEFAULTS,
  // The remote section is likewise a custom Component (owns no settings.json keys).
  ...REMOTE_SETTING_DEFAULTS,
};
