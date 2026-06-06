// Settings registry — the single place sections and their items live.
// SettingsSection contract (documented, not enforced — plain objects):
//   { id, label, Icon, groups: [{ title, items: [SettingItem] }] }
// SettingItem:
//   { key, label, description?, control: { type, ...props }, defaultValue }
//
// The modal, controls and persistence never change when settings are added
// (Open/Closed): a new setting is a registry entry, a new control type is one
// entry in controls.jsx CONTROLS. A section may provide `Component` instead
// of `groups` to render fully custom content.

const GeneralIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
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
            key: "general.placeholder",
            label: "Placeholder setting",
            description: "Example toggle — replace with real settings as they land.",
            control: { type: "toggle" },
            defaultValue: false,
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
