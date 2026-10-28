// The claude binary's file login store (<dir>/.credentials.json) — what it uses
// wherever there's no system keychain to keep it in.

import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "./HostPlatform.ts";

export const fileClaudeStore: Pick<CredentialStore, "readClaudeStore" | "clearClaudeStore"> = {
  readClaudeStore(storeDir) {
    try {
      return readFileSync(join(storeDir ?? join(homedir(), ".claude"), ".credentials.json"), "utf8");
    } catch {
      return null;
    }
  },
  clearClaudeStore(storeDir) {
    rmSync(join(storeDir, ".credentials.json"), { force: true });
  },
};
