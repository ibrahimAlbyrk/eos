// Built-in plugins: features that ship with Eos but are switched on and off like
// any plugin (Settings › Plugins). Turning one off removes it everywhere — its
// UI, its routes (they answer "turned off"), and, for sessions started after,
// its agent tools and prompt section. Its data stays.
//
// Ids start with "eos." — a prefix plugin folders may not use. The ids live with the
// dashboard (app/ui/src/shared/builtin-plugins.ts), one text for both sides.

import type { PluginManifest } from "./plugin.ts";
import { BUILTIN_PLUGINS } from "../../app/ui/src/shared/builtin-plugins.ts";

export { BUILTIN_PLUGIN_PREFIX, BUILTIN_PLUGINS } from "../../app/ui/src/shared/builtin-plugins.ts";

export const BUILTIN_PLUGIN_MANIFESTS: readonly PluginManifest[] = [
  {
    id: BUILTIN_PLUGINS.pages,
    name: "Pages",
    description: "Markdown notes and task lists you and your agents write together, in the side panel.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h7.8L18 7.7v12.8H6z"/><path d="M13.5 3.5v4.5H18M9 12.5h6M9 16h4"/></svg>',
  },
  {
    id: BUILTIN_PLUGINS.btw,
    name: "Side question",
    description: "Ask the agent a quick question with /btw (⌘/) without adding to the chat.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a8 8 0 0 1-11.8 7L4 20l1.6-4.1A8 8 0 1 1 20 11.5Z"/><path d="M10 9.3a2 2 0 1 1 2.8 1.9c-.6.3-.8.7-.8 1.3v.3M12 15.5h.01"/></svg>',
  },
  {
    id: BUILTIN_PLUGINS.artifacts,
    name: "Artifacts",
    description: "Your claude.ai artifacts in the side panel — opened, previewed and listed for every Claude sign-in.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M4 9h16"/></svg>',
  },
  {
    id: BUILTIN_PLUGINS.browser,
    name: "Browser",
    description: "A browser in the side panel that you and your agents can both drive.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.7" ry="8.5"/><path d="M3.8 9h16.4M3.8 15h16.4"/></svg>',
  },
  {
    id: BUILTIN_PLUGINS.autoName,
    name: "Auto-name",
    description: "Names a new chat after its first request.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2M12 5v14M9 19h6"/></svg>',
  },
  {
    id: BUILTIN_PLUGINS.terminal,
    name: "Terminal",
    description: "Shells in the side panel (⌃`).",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m6.5 9.5 3.5 3-3.5 3M12.5 15.5h5"/></svg>',
  },
];

// The DPI session fact a turned-off built-in sets (true) for sessions started
// while it's off — a fragment about that feature gates on its absence.
export const pluginOffFact = (id: string) => `plugin-off:${id}`;
