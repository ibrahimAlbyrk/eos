// Command registry. Adding a new command is: one file in this directory
// implementing Command, one entry in COMMANDS. Aliases route to the same
// command (e.g. "ls" → list, "stop" → kill).

import type { Command } from "./Command.ts";
import { hooksCommand } from "./hooks.ts";
import { listCommand } from "./list.ts";
import { spawnCommand } from "./spawn.ts";
import { showCommand } from "./show.ts";
import { logsCommand } from "./logs.ts";
import { killCommand } from "./kill.ts";
import { pendingCommand } from "./pending.ts";
import { approveCommand } from "./approve.ts";
import { denyCommand } from "./deny.ts";
import { orchestratorCommand } from "./orchestrator.ts";
import { chatCommand } from "./chat.ts";
import { daemonCommand } from "./daemon.ts";
import { webCommand } from "./web.ts";
import { configCommand } from "./config.ts";
import { doctorCommand } from "./doctor.ts";
import { createHelpCommand } from "./help.ts";

const COMMANDS: Command[] = [
  // Ordered by display priority in `claude-manager help`.
  daemonCommand,
  webCommand,
  hooksCommand,
  orchestratorCommand,
  chatCommand,
  listCommand,
  spawnCommand,
  showCommand,
  logsCommand,
  killCommand,
  pendingCommand,
  approveCommand,
  denyCommand,
  configCommand,
  doctorCommand,
];

const helpCommand = createHelpCommand(() => COMMANDS);
COMMANDS.push(helpCommand);

const byName = new Map<string, Command>();
for (const c of COMMANDS) {
  byName.set(c.name, c);
  for (const alias of c.aliases ?? []) byName.set(alias, c);
}

export function findCommand(name: string): Command | undefined {
  return byName.get(name);
}

export function listCommands(): ReadonlyArray<Command> {
  return COMMANDS;
}
