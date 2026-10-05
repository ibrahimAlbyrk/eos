import { DatabaseSync } from "node:sqlite";
import { sha256Hex, constantTimeHexEqual } from "../admission.ts";

// Sync vault persistence (docs/sync/00-SYNC-PLAN.md "Relay vault"). Blobs are opaque
// ciphertext under opaque keys; the relay only orders them (one monotonic seq per
// vault) and refuses a write whose base is stale (compare-and-swap per key).

export type VaultEntry = { key: string; seq: number; data: Buffer };

export type VaultChanges = { head: number; entries: VaultEntry[]; more: boolean };

export type PutResult =
  | { ok: true; seq: number }
  | { ok: false; reason: "conflict"; entry: VaultEntry | null }
  | { ok: false; reason: "quota" };

export type VaultLimits = { maxVaults: number; maxVaultBytes: number };

// A page stops early past this many blob bytes (always at least one entry), so a
// generous `limit` over 8 MiB blobs can't build a huge response.
const PAGE_BYTES = 16 * 1024 * 1024;

function toBuffer(v: unknown): Buffer {
  return v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.alloc(0);
}

export class VaultStore {
  private db: DatabaseSync;
  private limits: VaultLimits;
  private closed = false;

  constructor(path: string, limits: VaultLimits) {
    this.limits = limits;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY,
        auth_hash TEXT NOT NULL,
        head_seq INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        vault TEXT NOT NULL,
        key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (vault, key)
      );
      CREATE INDEX IF NOT EXISTS records_vault_seq ON records (vault, seq);
    `);
  }

  // First sight pins sha256(token) (TOFU, as rooms do).
  authorize(vault: string, authToken: string): "ok" | "forbidden" | "full" {
    const hash = sha256Hex(authToken);
    const row = this.db.prepare("SELECT auth_hash FROM vaults WHERE id = ?").get(vault);
    if (row) return constantTimeHexEqual(hash, String(row.auth_hash)) ? "ok" : "forbidden";
    const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM vaults").get()!.n);
    if (count >= this.limits.maxVaults) return "full";
    this.db.prepare("INSERT INTO vaults (id, auth_hash, created_at) VALUES (?, ?, ?)").run(vault, hash, Date.now());
    return "ok";
  }

  changes(vault: string, since: number, limit: number): VaultChanges {
    const row = this.db.prepare("SELECT head_seq FROM vaults WHERE id = ?").get(vault);
    const head = row ? Number(row.head_seq) : 0;
    const entries: VaultEntry[] = [];
    let bytes = 0;
    let more = false;
    const rows = this.db
      .prepare("SELECT key, seq, data FROM records WHERE vault = ? AND seq > ? ORDER BY seq LIMIT ?")
      .iterate(vault, since, limit + 1);
    for (const r of rows) {
      const data = toBuffer(r.data);
      if (entries.length === limit || (entries.length > 0 && bytes + data.length > PAGE_BYTES)) {
        more = true;
        break;
      }
      bytes += data.length;
      entries.push({ key: String(r.key), seq: Number(r.seq), data });
    }
    return { head, entries, more };
  }

  // The caller must have authorized the vault (that is what creates its row).
  put(vault: string, key: string, baseSeq: number, data: Buffer): PutResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.putLocked(vault, key, baseSeq, data);
      this.db.exec(result.ok ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private putLocked(vault: string, key: string, baseSeq: number, data: Buffer): PutResult {
    const v = this.db.prepare("SELECT head_seq, bytes FROM vaults WHERE id = ?").get(vault);
    if (!v) throw new Error(`unknown vault ${vault}`);
    const cur = this.db.prepare("SELECT seq, length(data) AS size FROM records WHERE vault = ? AND key = ?").get(vault, key);
    const curSeq = cur ? Number(cur.seq) : 0;
    if (curSeq !== baseSeq) return { ok: false, reason: "conflict", entry: cur ? this.entry(vault, key) : null };
    const bytes = Number(v.bytes) - (cur ? Number(cur.size) : 0) + data.length;
    if (bytes > this.limits.maxVaultBytes) return { ok: false, reason: "quota" };
    const seq = Number(v.head_seq) + 1;
    this.db
      .prepare("INSERT INTO records (vault, key, seq, data) VALUES (?, ?, ?, ?) ON CONFLICT (vault, key) DO UPDATE SET seq = excluded.seq, data = excluded.data")
      .run(vault, key, seq, data);
    this.db.prepare("UPDATE vaults SET head_seq = ?, bytes = ? WHERE id = ?").run(seq, bytes, vault);
    return { ok: true, seq };
  }

  private entry(vault: string, key: string): VaultEntry {
    const r = this.db.prepare("SELECT seq, data FROM records WHERE vault = ? AND key = ?").get(vault, key)!;
    return { key, seq: Number(r.seq), data: toBuffer(r.data) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
