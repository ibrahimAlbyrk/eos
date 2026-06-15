// Temp settings.json + tempdir. The mkdtemp prefix `eos-<name>-` is a hard
// contract — the daemon's force-kill `pgrep -f "eos-<name>-"` depends on it.

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface BuiltSettings {
  tmpDir: string;
  settingsPath: string;
}

export function buildClaudeSettings(name: string, port: number): BuiltSettings {
  const tmpDir = mkdtempSync(join(tmpdir(), `eos-${name}-`));
  const settingsPath = join(tmpDir, "settings.json");
  const repoRoot = process.env.EOS_REPO_ROOT || "";
  const httpHook = (event: string, matcher?: string): Record<string, unknown> => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "http", url: `http://127.0.0.1:${port}/event?event=${event}` }],
  });
  const hookScript = join(repoRoot, "scripts", "hooks", "auto-allow.sh");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        // Without this, a project-level .mcp.json in the target repo triggers
        // the "New MCP server found" boot dialog on every spawn (worktree
        // paths are always fresh, so the per-path trust never sticks) — the
        // readiness gate mistakes it for the composer and the initial prompt
        // is pasted into the dialog and lost.
        enableAllProjectMcpServers: true,
        // Eager-load every MCP tool schema. Inherited claude.ai connectors
        // (Gmail/Calendar/Drive/Notion/…) push the tool-def size over Claude
        // Code's tool-search threshold, which otherwise defers schemas — even
        // mcp__orchestrator__spawn_worker — behind a ToolSearch round-trip.
        toolSearchEnabled: false,
        permissions: {
          defaultMode: "default",
          ask: ["Bash", "Edit", "Write", "WebFetch", "Glob", "Grep"],
        },
        hooks: {
          ...(repoRoot ? { PermissionRequest: [{ hooks: [{ type: "command", command: hookScript }] }] } : {}),
          PreToolUse: [httpHook("PreToolUse")],
          // NOTE: http SessionStart hooks never fire (empirically — not even
          // at startup). Kept wired with "clear" included in case that is
          // fixed upstream; the tail retarget after /clear does NOT rely on
          // it (worker.ts polls for the new transcript file instead).
          SessionStart: [httpHook("SessionStart", "startup|clear")],
          Stop: [httpHook("Stop")],
          Notification: [httpHook("Notification")],
          PostToolUse: [httpHook("PostToolUse")],
          PostToolUseFailure: [httpHook("PostToolUseFailure")],
          SessionEnd: [httpHook("SessionEnd")],
        },
      },
      null,
      2,
    ),
  );
  return { tmpDir, settingsPath };
}
