// Temp settings.json + tempdir. The mkdtemp prefix `cm-<name>-` is a hard
// contract — the daemon's force-kill `pgrep -f "cm-<name>-"` depends on it.

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface BuiltSettings {
  tmpDir: string;
  settingsPath: string;
}

export function buildClaudeSettings(name: string, port: number): BuiltSettings {
  const tmpDir = mkdtempSync(join(tmpdir(), `cm-${name}-`));
  const settingsPath = join(tmpDir, "settings.json");
  const hook = (event: string, matcher?: string): Record<string, unknown> => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "http", url: `http://127.0.0.1:${port}/event?event=${event}` }],
  });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: {
          defaultMode: "default",
          ask: ["Bash", "Edit", "Write", "WebFetch", "Glob", "Grep"],
        },
        hooks: {
          SessionStart: [hook("SessionStart", "startup")],
          Stop: [hook("Stop")],
          Notification: [hook("Notification")],
          PostToolUse: [hook("PostToolUse")],
          SessionEnd: [hook("SessionEnd")],
        },
      },
      null,
      2,
    ),
  );
  return { tmpDir, settingsPath };
}
