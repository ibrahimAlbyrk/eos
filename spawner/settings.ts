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
  const repoRoot = process.env.CLAUDE_MGR_REPO_ROOT || "";
  const httpHook = (event: string, matcher?: string): Record<string, unknown> => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "http", url: `http://127.0.0.1:${port}/event?event=${event}` }],
  });
  const hookScript = join(repoRoot, "scripts", "hooks", "auto-allow.sh");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: {
          defaultMode: "default",
          ask: ["Bash", "Edit", "Write", "WebFetch", "Glob", "Grep"],
        },
        hooks: {
          ...(repoRoot ? { PermissionRequest: [{ hooks: [{ type: "command", command: hookScript }] }] } : {}),
          PreToolUse: [httpHook("PreToolUse")],
          SessionStart: [httpHook("SessionStart", "startup")],
          Stop: [httpHook("Stop")],
          Notification: [httpHook("Notification")],
          PostToolUse: [httpHook("PostToolUse")],
          SessionEnd: [httpHook("SessionEnd")],
        },
      },
      null,
      2,
    ),
  );
  return { tmpDir, settingsPath };
}
