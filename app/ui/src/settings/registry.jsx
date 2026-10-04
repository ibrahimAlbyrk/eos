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

import { AccountsSettings } from "./AccountsSettings.jsx";
import { ProfileSettings } from "./ProfileSettings.jsx";
import { UsageSettings, USAGE_SETTING_DEFAULTS } from "./UsageSettings.jsx";
import { REMOTE_SETTING_DEFAULTS } from "./RemoteSettings.jsx";
import { RemoteAccessSettings } from "./RemoteAccessSettings.jsx";
import { MachinesSettings } from "./MachinesSettings.jsx";

export const GeneralIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const CodeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
  </svg>
);

const ProfileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <circle cx="9" cy="11" r="2.2" />
    <path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M15 10h3M15 13.5h3" />
  </svg>
);

const AccountsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20c1.4-3.6 4.3-5.5 7.5-5.5s6.1 1.9 7.5 5.5" />
  </svg>
);

const UsageIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" />
    <path d="M7 15l4-4 3 3 5-6" />
  </svg>
);

const MachinesIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
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
    id: "profile",
    label: "Profile",
    Icon: ProfileIcon,
    // Custom Component: who the user is, as every agent sees it. Owns no
    // settings.json keys — the profile lives in ~/.eos/profile behind /api/profile.
    Component: ProfileSettings,
  },
  {
    id: "general",
    label: "General",
    Icon: GeneralIcon,
    groups: [
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
        // compaction.* persists to ~/.eos/config.json (the daemon's idle-edge
        // trigger reads it live) — see CONFIG_BLOCKS in state/settings.jsx.
        title: "Context",
        items: [
          {
            key: "compaction.enabled",
            label: "Auto-compact",
            description:
              "When an agent finishes a turn with its context window at or above the threshold, summarize the conversation and continue in a fresh context. Type /compact to do it any time.",
            control: { type: "toggle" },
            defaultValue: true,
          },
          {
            key: "compaction.threshold",
            label: "Compact at",
            description: "How full the context window gets before an agent is compacted.",
            control: { type: "slider", min: 0.5, max: 0.95, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
            defaultValue: 0.7,
            visibleWhen: (s) => s["compaction.enabled"] !== false,
          },
        ],
      },
      {
        // archive.* persists to ~/.eos/config.json (the daemon reads it), not
        // the settings.json store — see CONFIG_BLOCKS in state/settings.jsx.
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
    id: "accounts",
    label: "Accounts",
    Icon: AccountsIcon,
    // Custom Component: every provider's sign-in + API key (cards + tiles). Owns
    // no settings.json keys — accounts live in config.json / the Keychain behind
    // /api/accounts.
    Component: AccountsSettings,
  },
  {
    id: "usage",
    label: "Usage",
    Icon: UsageIcon,
    // Custom Component: read-only subscription usage (plan limits + reset times),
    // fetched live from /api/usage. Owns no settings.json keys.
    Component: UsageSettings,
  },
  {
    id: "remote",
    label: "Remote access",
    Icon: RemoteIcon,
    // Custom Component: who may control THIS Mac — paired computers (Eos ↔ Eos
    // peering, /api/peer) and the iPhone relay section. Owns no settings.json
    // keys (config.peer / config.remote live in config.json).
    Component: RemoteAccessSettings,
  },
  {
    id: "machines",
    label: "Machines",
    Icon: MachinesIcon,
    // Custom Component: the computers this Mac controls (/api/hosts).
    Component: MachinesSettings,
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
  // What new agents launch on (seeds the composer — see state/settings.jsx); set
  // from the composer itself, so no section surfaces them.
  "model.provider": "claude",
  "model.default": "opus",
  // The first-run welcome was skipped — don't show it again (App.jsx).
  "onboarding.dismissed": false,
  // The first-run profile interview was skipped — don't offer it again.
  "onboarding.profileDismissed": false,
  // The usage + remote sections are custom Components (they own no settings.json
  // keys — their state lives in config.json).
  ...USAGE_SETTING_DEFAULTS,
  ...REMOTE_SETTING_DEFAULTS,
};
