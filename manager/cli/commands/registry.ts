import type { Command } from "./Command.ts";
import { hooksCommand } from "./hooks.ts";
import { listCommand } from "./list.ts";
import { spawnCommand } from "./spawn.ts";
import { showCommand } from "./show.ts";
import { logsCommand } from "./logs.ts";
import { killCommand } from "./kill.ts";
import { permCommand } from "./perm.ts";
import { orchestratorCommand } from "./orchestrator.ts";
import { chatCommand } from "./chat.ts";
import { startCommand } from "./start.ts";
import { stopCommand } from "./stop.ts";
import { statusCommand } from "./status.ts";
import { restartCommand } from "./restart.ts";
import { buildCommand } from "./build.ts";
import { configCommand } from "./config.ts";
import { doctorCommand } from "./doctor.ts";
import { createHelpCommand } from "./help.ts";

const COMMANDS: Command[] = [
  // Ordered by display priority in `eos help`.
  startCommand,
  stopCommand,
  restartCommand,
  buildCommand,
  statusCommand,
  hooksCommand,
  orchestratorCommand,
  chatCommand,
  listCommand,
  spawnCommand,
  showCommand,
  logsCommand,
  killCommand,
  permCommand,
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
