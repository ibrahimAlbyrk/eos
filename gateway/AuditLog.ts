// Audit log writer + naive size-based rotation. Append-only JSONL; one
// record per permission decision. macOS + Linux only — no Windows path
// quoting concerns.

import { mkdirSync, appendFileSync, statSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuditLogOptions {
  dir?: string;
  filename?: string;
  maxBytes?: number;
  keep?: number;
}

export class AuditLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(opts: AuditLogOptions = {}) {
    const dir = opts.dir ?? join(homedir(), ".claude-mgr");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, opts.filename ?? "audit.jsonl");
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.keep = opts.keep ?? 3;
  }

  append(record: Record<string, unknown>): void {
    this.rotateIfLarge();
    try {
      appendFileSync(this.path, JSON.stringify(record) + "\n");
    } catch (e) {
      process.stderr.write(`[gateway] audit write failed: ${(e as Error).message}\n`);
    }
  }

  private rotateIfLarge(): void {
    try {
      const st = statSync(this.path);
      if (st.size < this.maxBytes) return;
    } catch { return; /* no file yet */ }
    try {
      const oldest = `${this.path}.${this.keep}`;
      if (existsSync(oldest)) { try { unlinkSync(oldest); } catch {} }
      for (let i = this.keep - 1; i >= 1; i--) {
        const src = `${this.path}.${i}`;
        const dst = `${this.path}.${i + 1}`;
        if (existsSync(src)) { try { renameSync(src, dst); } catch {} }
      }
      renameSync(this.path, `${this.path}.1`);
    } catch (e) {
      process.stderr.write(`[gateway] audit log rotation failed: ${(e as Error).message}\n`);
    }
  }
}
