// Append-only audit log of every remote-originated control action (design
// §4.6): {device, action, target, ts, result}. Surfaced in the Mac app. JSONL
// so it is append-cheap and tail-readable; never rewritten.

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { safeStringify } from "../../infra/src/util/json.ts";

export interface AuditEntry {
  device: string; // devId
  action: string; // method + path, e.g. "DELETE /workers/abc"
  target: string; // resource id the action touched
  ts: number;
  result: "ok" | "denied" | "error";
}

export class RemoteAuditLog {
  private readonly path: string;

  constructor(remoteDir: string) {
    this.path = join(remoteDir, "remote-audit.log");
    mkdirSync(dirname(this.path), { recursive: true });
  }

  append(entry: AuditEntry): void {
    appendFileSync(this.path, safeStringify(entry) + "\n");
  }

  // Newest-last entries, capped. Best-effort: a partially-written tail line is
  // skipped rather than throwing.
  read(limit = 200): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    const out: AuditEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line) as AuditEntry); } catch { /* skip torn line */ }
    }
    return out;
  }
}
