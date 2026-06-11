import { useMemo } from "react";
import { useCommands } from "./useCommands.js";
import { useTemplates } from "./useTemplates.js";

// Native Claude TUI commands the agent executes itself — sent as a plain
// message ("/clear" pasted + CR runs the command); listed for discoverability.
export const BUILTIN_COMMANDS = [
  { name: "clear", description: "Clear conversation history (agent context + chat)", source: "builtin" },
];

// The full slash universe for a cwd: builtins + daemon commands + templates.
// Shared by the composer menu/pills and the message-bubble pill rule so both
// surfaces recognize the same names. Same name allowed across sources — the
// "(template)" / "(skill)" source tag disambiguates.
export function useSlashItems(cwd) {
  const commands = useCommands(cwd);
  const templates = useTemplates();
  return useMemo(() => [
    ...BUILTIN_COMMANDS,
    ...commands,
    ...templates.map((t) => ({ name: t.name, description: t.description, source: "template", template: t })),
  ], [commands, templates]);
}
