// Where a provider's CLI lives. Eos drives the user's own install — the one on
// PATH (npm / Homebrew), else a copy an app bundle ships — so it runs the version
// the user signed in with. An EOS_<NAME>_BIN override wins.

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// The daemon may run with a launchd-minimal PATH, so the usual install dirs are
// searched too.
const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".npm-global", "bin")];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CliLocation {
  name: string;
  overrideVar: string;
  /** Last-resort absolute paths (e.g. inside a desktop app bundle). */
  bundles?: readonly string[];
}

export function resolveCliBinary(cli: CliLocation, env: Record<string, string | undefined> = process.env): string | null {
  const override = env[cli.overrideVar]?.trim();
  if (override) return executable(override) ? override : null;
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...EXTRA_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, cli.name);
    if (executable(candidate)) return candidate;
  }
  return cli.bundles?.find(executable) ?? null;
}
