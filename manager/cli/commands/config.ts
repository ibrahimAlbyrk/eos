import type { Command } from "./Command.ts";

export const configCommand: Command = {
  name: "config",
  description: "Dump merged config (print) or write a starter config.json (init)",
  usage: "claude-manager config [print|init]",
  async run(args, ctx): Promise<void> {
    const sub = args[0];
    if (sub === "print" || sub === undefined) {
      console.log(JSON.stringify(ctx.config, null, 2));
      return;
    }
    if (sub === "init") {
      const { writeDefaultConfig } = await import("../../shared/config.ts");
      const path = writeDefaultConfig();
      console.log(`wrote ${path}`);
      console.log("edit it, then restart the daemon for changes to take effect.");
      return;
    }
    console.error(`unknown config subcommand: ${sub} (use: print, init)`);
    process.exit(1);
  },
};
