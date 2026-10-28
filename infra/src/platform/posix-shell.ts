import { basename } from "node:path";
import type { TerminalShell } from "./HostPlatform.ts";

// Per-shell flag specs. zsh reads .zshrc only in interactive shells, so it
// needs -i (and stays silent without a TTY); bash -i without a TTY prints
// "no job control in this shell" on every run, so bash stays login-only
// (.bash_profile conventionally sources .bashrc). fish reads config.fish
// unconditionally. Adding a shell = one entry here.
const SHELL_SPECS: Record<string, string[]> = {
  zsh: ["-i", "-l", "-c"],
  bash: ["-l", "-c"],
  fish: ["-l", "-c"],
};

const FALLBACK_FLAGS = ["-l", "-c"];

export function buildShellInvocation(
  shellPath: string,
  command: string,
): { file: string; args: string[] } {
  const flags = SHELL_SPECS[basename(shellPath)] ?? FALLBACK_FLAGS;
  return { file: shellPath, args: [...flags, command] };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The user's login shell. A terminal tab is an interactive login shell (rc files
// set PATH/aliases); with a command, that shell runs it, then execs a plain
// login shell so the tab outlives the command.
export const posixShell: TerminalShell = {
  interactive({ command, exitAfterCommand } = {}) {
    const shell = process.env.SHELL || "/bin/bash";
    const args = !command
      ? ["-l"]
      : exitAfterCommand
        ? ["-l", "-i", "-c", command]
        : ["-l", "-i", "-c", `${command}; exec ${shellQuote(shell)} -l`];
    return { file: shell, args };
  },
  // The user's own login shell, not bash: a foreign shell sourcing the user's
  // profile sprays "bad substitution" noise into every command.
  run: (command) => buildShellInvocation(process.env.SHELL || "/bin/bash", command),
  orElse: (a, b) => `${a} || ${b}`,
  ttyHooks: true,
};
