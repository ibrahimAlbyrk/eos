import { DatabaseSync } from "node:sqlite";
import type { ApnsEnv, PushTarget } from "./apns.ts";

// Phone push tokens per room and device (07 G20), in the vault's SQLite file. They outlive the
// phone's socket, so a push reaches a closed phone app, and the room owner's hash outlives the
// Mac's socket and a relay restart, so the Mac can push over HTTP while it is not connected.
export class PushTokens {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS push_tokens (
        room TEXT,
        device_hash TEXT,
        token TEXT,
        env TEXT,
        updated_ms INTEGER,
        PRIMARY KEY (room, device_hash)
      );
      CREATE TABLE IF NOT EXISTS push_rooms (
        room TEXT PRIMARY KEY,
        owner_hash TEXT NOT NULL,
        updated_ms INTEGER NOT NULL
      );
    `);
  }

  ownerHash(room: string): string | null {
    const row = this.db.prepare("SELECT owner_hash FROM push_rooms WHERE room = ?").get(room);
    return row ? String(row.owner_hash) : null;
  }

  // A registration names the owner and the whole allowlist: a device left out of it was removed.
  keepRoom(room: string, ownerHash: string, allow: string[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO push_rooms (room, owner_hash, updated_ms) VALUES (?, ?, ?) ON CONFLICT (room) DO UPDATE SET owner_hash = excluded.owner_hash, updated_ms = excluded.updated_ms")
        .run(room, ownerHash, this.now());
      const kept = new Set(allow);
      for (const row of this.db.prepare("SELECT device_hash FROM push_tokens WHERE room = ?").all(room)) {
        const hash = String(row.device_hash);
        if (!kept.has(hash)) this.remove(room, hash);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  save(room: string, deviceHash: string, token: string, env: ApnsEnv): void {
    this.db
      .prepare("INSERT INTO push_tokens (room, device_hash, token, env, updated_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT (room, device_hash) DO UPDATE SET token = excluded.token, env = excluded.env, updated_ms = excluded.updated_ms")
      .run(room, deviceHash, token, env, this.now());
  }

  remove(room: string, deviceHash: string): void {
    this.db.prepare("DELETE FROM push_tokens WHERE room = ? AND device_hash = ?").run(room, deviceHash);
  }

  // Only the token Apple called gone: the phone may have joined with a new one while the send was out.
  removeToken(room: string, deviceHash: string, token: string): void {
    this.db.prepare("DELETE FROM push_tokens WHERE room = ? AND device_hash = ? AND token = ?").run(room, deviceHash, token);
  }

  targets(room: string): (PushTarget & { deviceHash: string })[] {
    return this.db
      .prepare("SELECT device_hash, token, env FROM push_tokens WHERE room = ? ORDER BY device_hash")
      .all(room)
      .map((row) => ({ deviceHash: String(row.device_hash), token: String(row.token), env: String(row.env) === "sandbox" ? "sandbox" : "production" }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
