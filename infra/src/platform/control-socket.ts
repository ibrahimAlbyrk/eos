// Where the daemon's local control plane listens for an Eos home: a unix socket
// file, or a Windows named pipe (Node serves no socket files there) — one per
// home either way. The desktop shell (app/src/main) probes the same endpoint,
// so this file stays free of .ts-extension imports the app's tsc can't read.

import { createHash } from "node:crypto";
import { join } from "node:path";

export function controlSocketPath(home: string, kind: "socket" | "pipe"): string {
  if (kind === "socket") return join(home, "daemon.sock");
  return `\\\\.\\pipe\\eos-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}`;
}
