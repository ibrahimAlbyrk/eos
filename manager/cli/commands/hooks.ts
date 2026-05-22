// `claude-manager hooks install` — copies the canonical auto-allow.sh into
// ~/.claude/hooks/ and surfaces registration instructions when settings.json
// doesn't already wire it up. Sanity-checks jq + curl presence.

import { mkdirSync, copyFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import type { Command, CommandContext } from "./Command.ts";

function which(bin: string): string {
  try { return execSync(`command -v ${bin}`, { encoding: "utf8" }).trim(); } catch { return ""; }
}

async function install(ctx: CommandContext): Promise<void> {
  const src = join(ctx.repoRoot, "scripts", "hooks", "auto-allow.sh");
  if (!existsSync(src)) {
    console.error(`error: hook script not found at ${src}`);
    process.exit(1);
  }
  const dstDir = join(homedir(), ".claude", "hooks");
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, "auto-allow.sh");

  if (existsSync(dst)) {
    const existing = readFileSync(dst, "utf8");
    const incoming = readFileSync(src, "utf8");
    if (existing === incoming) {
      console.log(`hook up-to-date at ${dst}`);
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const backup = `${dst}.bak.${stamp}`;
      copyFileSync(dst, backup);
      copyFileSync(src, dst);
      console.log(`hook updated at ${dst}`);
      console.log(`previous version backed up to ${backup}`);
    }
  } else {
    copyFileSync(src, dst);
    console.log(`hook installed at ${dst}`);
  }
  try { chmodSync(dst, 0o755); } catch {}

  // Surface settings.json status — we don't auto-edit user settings.json
  // because a botched merge there can break their entire claude setup.
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let registered = false;
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      const hooks = s?.hooks?.PermissionRequest;
      if (Array.isArray(hooks)) {
        registered = hooks.some((h: { hooks?: Array<{ command?: string }> }) =>
          (h.hooks ?? []).some((c) => typeof c.command === "string" && c.command.includes("auto-allow.sh")));
      }
    } catch {}
  }
  if (!registered) {
    console.log("");
    console.log("the hook is not yet registered in ~/.claude/settings.json — add this block:");
    console.log("");
    console.log("  {");
    console.log("    \"hooks\": {");
    console.log("      \"PermissionRequest\": [");
    console.log("        { \"hooks\": [ { \"type\": \"command\", \"command\": \"" + dst + "\" } ] }");
    console.log("      ]");
    console.log("    }");
    console.log("  }");
  }

  if (!which("jq")) {
    console.log("");
    console.log("warning: `jq` not found in PATH — hook requires jq (brew install jq)");
  }
  if (!which("curl")) {
    console.log("warning: `curl` not found in PATH — hook requires curl");
  }
}

export const hooksCommand: Command = {
  name: "hooks",
  description: "Install + verify the PermissionRequest hook for daemon-spawned workers",
  async run(args, ctx): Promise<void> {
    const sub = args[0];
    if (sub === "install") {
      await install(ctx);
      return;
    }
    console.error("usage: claude-manager hooks install");
    process.exit(1);
  },
};
