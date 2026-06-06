// Pure resolution of a tool's default expanded state from user settings.
// Verbose off (default) = everything collapsed. Verbose on = the mode
// decides: all expanded / only selected expanded / only selected collapsed
// (the shared verbose.tools list feeds the latter two). The transient
// expandedTools Set in selection.jsx holds *toggles* against this default
// (XOR at the read sites), so clicking always inverts what settings chose.

export const VERBOSE_ENABLED_KEY = "verbose.enabled";
export const VERBOSE_MODE_KEY = "verbose.mode";
export const VERBOSE_TOOLS_KEY = "verbose.tools";

export function defaultToolExpanded(toolName, settings) {
  if (!settings?.[VERBOSE_ENABLED_KEY]) return false;
  const mode = settings?.[VERBOSE_MODE_KEY];
  const tools = settings?.[VERBOSE_TOOLS_KEY] ?? [];
  if (mode === "selectedExpanded") return tools.includes(toolName);
  if (mode === "selectedCollapsed") return !tools.includes(toolName);
  return true; // "expanded" (default while verbose is on)
}

export function defaultGroupOpen(tools, settings) {
  return (tools ?? []).some((t) => defaultToolExpanded(t.name, settings));
}
