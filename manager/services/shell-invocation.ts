import { basename } from "node:path";

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
