// PowerShell: PowerShell 7 (pwsh) when installed, else the Windows PowerShell
// every Windows ships. Both load the user's profile unless told not to.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TerminalShell } from "./HostPlatform.ts";

// Git for Windows' bash — the sh Claude Code's Bash tool uses too (it honours
// CLAUDE_CODE_GIT_BASH_PATH the same way).
export function gitBash(): string | null {
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  ];
  return candidates.find((p): p is string => Boolean(p) && existsSync(p as string)) ?? null;
}

function powershell(): string {
  const pwsh = join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  return existsSync(pwsh) ? pwsh : "powershell.exe";
}

export const win32Shell: TerminalShell = {
  interactive({ command, exitAfterCommand } = {}) {
    const args = !command ? ["-NoLogo"] : exitAfterCommand ? ["-NoLogo", "-Command", command] : ["-NoLogo", "-NoExit", "-Command", command];
    return { file: powershell(), args };
  },
  run: (command) => ({ file: powershell(), args: ["-NoLogo", "-NonInteractive", "-Command", command] }),
  // `||` is PowerShell 7 only; $LASTEXITCODE works in both.
  orElse: (a, b) => `${a}; if ($LASTEXITCODE -ne 0) { ${b} }`,
  // A ConPTY has no device path a hook could write to.
  ttyHooks: false,
};
