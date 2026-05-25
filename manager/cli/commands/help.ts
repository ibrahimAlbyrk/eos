// `eos help` (or no-args) — generated from the registry so a new
// command's usage line appears automatically without editing the help text.

import type { Command } from "./Command.ts";

const ENV_DOCS = `
env:
  CLAUDE_MGR_URL        daemon URL (default http://127.0.0.1:7400)
  CLAUDE_MGR_LOG_LEVEL  debug | info | warn | error (default info)
`;

export function createHelpCommand(getCommands: () => ReadonlyArray<Command>): Command {
  return {
    name: "help",
    aliases: ["-h", "--help"],
    description: "Show this help text",
    usage: "eos help",
    async run(): Promise<void> {
      const commands = getCommands();
      console.log("eos — orchestration CLI for Claude Code workers\n");
      console.log("usage:");
      for (const c of commands) {
        if (c.name === "help") continue;
        const usage = c.usage ?? `eos ${c.name}`;
        const aliasLine = c.aliases && c.aliases.length > 0 ? ` (aliases: ${c.aliases.join(", ")})` : "";
        console.log(`  ${usage}`);
        console.log(`      ${c.description}${aliasLine}`);
      }
      console.log(ENV_DOCS);
    },
  };
}
