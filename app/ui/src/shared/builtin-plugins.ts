// Built-in plugins: features that ship with Eos but are switched on and off like
// any plugin (Settings › Plugins). Turning one off removes it everywhere — its
// UI, its routes (they answer "turned off"), and, for sessions started after,
// its agent tools and prompt section. Its data stays.
//
// Ids start with "eos." — a prefix plugin folders may not use.

export const BUILTIN_PLUGIN_PREFIX = "eos.";

export const BUILTIN_PLUGINS = {
  pages: "eos.pages",
  btw: "eos.btw",
  artifacts: "eos.artifacts",
  browser: "eos.browser",
  autoName: "eos.auto-name",
  terminal: "eos.terminal",
  // Built like a plugin, but a core feature: always on, never listed or switched
  // off (it has no manifest).
  archive: "eos.archive",
} as const;
