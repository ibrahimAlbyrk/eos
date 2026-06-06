import { SETTINGS_SECTIONS } from "../../settings/registry.jsx";

// Settings sections as palette results. Selecting one opens the settings
// modal focused on that section.
export const settingsProvider = {
  id: "settings",
  label: "Settings",
  getResults() {
    return SETTINGS_SECTIONS.map((s) => ({
      id: `settings:${s.id}`,
      icon: "settings",
      title: `Settings: ${s.label}`,
      subtitle: "open settings",
      keywords: ["settings", "preferences", s.label.toLowerCase()],
      onSelect: (ctx) => ctx.openSettings(s.id),
    }));
  },
};
