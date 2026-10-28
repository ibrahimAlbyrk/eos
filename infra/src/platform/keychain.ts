// The macOS Keychain, through security(1): where the claude binary keeps its
// logins and where Eos keeps provider API keys.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// The Keychain item the claude binary keeps a store's login in: a store dir set
// through CLAUDE_SECURESTORAGE_CONFIG_DIR gets its own item, suffixed with a hash of that dir.
export function claudeStoreService(storeDir?: string): string {
  if (!storeDir) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(storeDir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

export function readKeychainItem(service: string): string | null {
  try {
    const v = execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return v || null;
  } catch {
    return null;
  }
}

export function deleteKeychainItem(service: string): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", service], { stdio: "ignore" });
  } catch {
    // No item: nothing to delete.
  }
}

// `-U` updates an existing item so re-adding a provider rotates the key in place.
// NOTE (m5): the secret is passed via argv (`-w <secret>`), briefly visible to a
// same-user `ps`. `security add-generic-password` exposes no stdin/file channel for
// the password, so there is no clean mitigation — accepted as a same-user-only
// exposure; the key never reaches config.json/SQLite/logs/events.
export function writeKeychainItem(service: string, secret: string): void {
  execFileSync("security", ["add-generic-password", "-U", "-s", service, "-a", service, "-w", secret], { encoding: "utf8" });
}
