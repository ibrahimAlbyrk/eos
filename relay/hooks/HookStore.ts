import { DatabaseSync } from "node:sqlite";
import { constantTimeHexEqual, sha256Hex } from "../admission.ts";

// The hook inboxes (07 §4.7), in the vault's SQLite file. An inbox belongs to one Mac (its
// bearer is pinned on first sight, as vaults are) and holds that Mac's hooks and the sealed
// events outside services posted to them while the Mac was away.

export const MAX_HOOKS = 64;
export const MAX_EVENTS = 2000;
export const MAX_INBOX_BYTES = 64 * 1024 * 1024;
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export type HookEntry = { seq: number; sealed: Buffer };
export type HookEvents = { head: number; entries: HookEntry[]; dropped: number };
export type Verdict = "ok" | "unknown" | "forbidden";

function toBuffer(v: unknown): Buffer {
  return v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.alloc(0);
}

export class HookStore {
  private readonly db: DatabaseSync;
  private readonly maxInboxes: number;
  private readonly now: () => number;
  private closed = false;

  constructor(path: string, maxInboxes: number, now: () => number = Date.now) {
    this.maxInboxes = maxInboxes;
    this.now = now;
    this.db = new DatabaseSync(path);
    // `head_seq` keeps seqs growing after an ack empties the inbox, so a Mac's cursor never
    // skips a later event.
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS hook_inboxes (
        inbox TEXT PRIMARY KEY,
        bearer_hash TEXT NOT NULL,
        public_key BLOB NOT NULL,
        created_ms INTEGER NOT NULL,
        dropped INTEGER NOT NULL DEFAULT 0,
        head_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS hooks (
        hook TEXT PRIMARY KEY,
        inbox TEXT NOT NULL,
        created_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hooks_inbox ON hooks (inbox);
      CREATE TABLE IF NOT EXISTS hook_events (
        inbox TEXT NOT NULL,
        seq INTEGER NOT NULL,
        received_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sealed BLOB NOT NULL,
        PRIMARY KEY (inbox, seq)
      );
      CREATE INDEX IF NOT EXISTS hook_events_received ON hook_events (received_ms);
    `);
  }

  // Creates the inbox on first sight, pinning SHA-256(bearer); the owner may replace its key.
  ensure(inbox: string, bearer: string, publicKey: Buffer): "ok" | "forbidden" | "full" {
    const verdict = this.authorize(inbox, bearer);
    if (verdict === "forbidden") return verdict;
    if (verdict === "ok") {
      this.db.prepare("UPDATE hook_inboxes SET public_key = ? WHERE inbox = ?").run(publicKey, inbox);
      return "ok";
    }
    const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM hook_inboxes").get()!.n);
    if (count >= this.maxInboxes) return "full";
    this.db
      .prepare("INSERT INTO hook_inboxes (inbox, bearer_hash, public_key, created_ms) VALUES (?, ?, ?, ?)")
      .run(inbox, sha256Hex(bearer), publicKey, this.now());
    return "ok";
  }

  authorize(inbox: string, bearer: string): Verdict {
    const row = this.db.prepare("SELECT bearer_hash FROM hook_inboxes WHERE inbox = ?").get(inbox);
    if (!row) return "unknown";
    return constantTimeHexEqual(sha256Hex(bearer), String(row.bearer_hash)) ? "ok" : "forbidden";
  }

  // "taken" when the id belongs to another inbox.
  addHook(inbox: string, hook: string): "ok" | "taken" | "full" {
    const owner = this.db.prepare("SELECT inbox FROM hooks WHERE hook = ?").get(hook);
    if (owner) return String(owner.inbox) === inbox ? "ok" : "taken";
    const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM hooks WHERE inbox = ?").get(inbox)!.n);
    if (count >= MAX_HOOKS) return "full";
    this.db.prepare("INSERT INTO hooks (hook, inbox, created_ms) VALUES (?, ?, ?)").run(hook, inbox, this.now());
    return "ok";
  }

  removeHook(inbox: string, hook: string): void {
    this.db.prepare("DELETE FROM hooks WHERE hook = ? AND inbox = ?").run(hook, inbox);
  }

  // The key an event for this hook is sealed to; null when the hook is not in that inbox.
  recipient(inbox: string, hook: string): Buffer | null {
    const row = this.db
      .prepare("SELECT i.public_key FROM hooks h JOIN hook_inboxes i ON i.inbox = h.inbox WHERE h.hook = ? AND h.inbox = ?")
      .get(hook, inbox);
    return row ? toBuffer(row.public_key) : null;
  }

  // An inbox at its count or size limit refuses the new event; the Mac's polls cover the gap.
  append(inbox: string, sealed: Buffer): number | "full" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const held = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM hook_events WHERE inbox = ?").get(inbox)!;
      if (Number(held.n) >= MAX_EVENTS || Number(held.bytes) + sealed.length > MAX_INBOX_BYTES) {
        this.db.exec("ROLLBACK");
        return "full";
      }
      const seq = Number(this.db.prepare("SELECT head_seq FROM hook_inboxes WHERE inbox = ?").get(inbox)!.head_seq) + 1;
      this.db
        .prepare("INSERT INTO hook_events (inbox, seq, received_ms, size, sealed) VALUES (?, ?, ?, ?, ?)")
        .run(inbox, seq, this.now(), sealed.length, sealed);
      this.db.prepare("UPDATE hook_inboxes SET head_seq = ? WHERE inbox = ?").run(seq, inbox);
      this.db.exec("COMMIT");
      return seq;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  events(inbox: string, since: number, limit: number): HookEvents {
    this.sweep();
    const row = this.db.prepare("SELECT head_seq, dropped FROM hook_inboxes WHERE inbox = ?").get(inbox)!;
    const entries = this.db
      .prepare("SELECT seq, sealed FROM hook_events WHERE inbox = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(inbox, since, limit)
      .map((r) => ({ seq: Number(r.seq), sealed: toBuffer(r.sealed) }));
    return { head: Number(row.head_seq), entries, dropped: Number(row.dropped) };
  }

  ack(inbox: string, through: number): void {
    this.db.prepare("DELETE FROM hook_events WHERE inbox = ? AND seq <= ?").run(inbox, through);
  }

  // Events older than seven days go; each inbox counts what it lost.
  sweep(): void {
    const cutoff = this.now() - KEEP_MS;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT inbox, COUNT(*) AS n FROM hook_events WHERE received_ms < ? GROUP BY inbox").all(cutoff);
      for (const r of old) this.db.prepare("UPDATE hook_inboxes SET dropped = dropped + ? WHERE inbox = ?").run(Number(r.n), String(r.inbox));
      this.db.prepare("DELETE FROM hook_events WHERE received_ms < ?").run(cutoff);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
