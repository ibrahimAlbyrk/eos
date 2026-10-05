// Sync files under ~/.eos/sync (user data — the identity is the only copy of the key
// on a Mac whose peers are gone):
//   identity.json   relay URL + secret (0600)
//   state.json      vault cursor + per-record index (regenerable: a fresh index
//                   re-pulls the vault, matching content is not a conflict)
//   conflicts/      the losing side of each conflict, <domain>/<id>.<stamp>.json

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { SyncLocalState, SyncStateStore } from "../../../core/src/ports/SyncStateStore.ts";
import { writeFileAtomic } from "../persistence/atomic-file.ts";
import type { SyncIdentity } from "./sync-key.ts";

const StateSchema = z.object({
  cursor: z.number().int().nonnegative(),
  index: z.record(z.string(), z.object({ seq: z.number().int().nonnegative(), hash: z.string().nullable() })),
});

const IdentitySchema = z.object({ relayUrl: z.string().min(1), secret: z.string().min(1) });

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export class FileSyncStateStore implements SyncStateStore {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.now = now;
  }

  load(): SyncLocalState {
    const parsed = StateSchema.safeParse(readJson(join(this.dir, "state.json")));
    return parsed.success ? parsed.data : { cursor: 0, index: {} };
  }

  save(state: SyncLocalState): void {
    writeFileAtomic(join(this.dir, "state.json"), JSON.stringify(state));
  }

  saveConflict(domain: string, id: string, data: unknown): void {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    const safeId = id.replace(/[^A-Za-z0-9._-]/g, "_");
    writeFileAtomic(join(this.dir, "conflicts", domain, `${safeId}.${stamp}.json`), JSON.stringify(data, null, 2));
  }

  // Leaving the account: the next key starts from an empty index.
  reset(): void {
    rmSync(join(this.dir, "state.json"), { force: true });
  }
}

export class FileSyncIdentityStore {
  private readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "identity.json");
  }

  load(): SyncIdentity | null {
    const parsed = IdentitySchema.safeParse(readJson(this.path));
    if (!parsed.success) return null;
    return { relayUrl: parsed.data.relayUrl, secret: new Uint8Array(Buffer.from(parsed.data.secret, "base64url")) };
  }

  // Written owner-only from the first byte — the secret is the account.
  save(id: SyncIdentity): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ relayUrl: id.relayUrl, secret: Buffer.from(id.secret).toString("base64url") }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  clear(): void {
    if (existsSync(this.path)) rmSync(this.path);
  }
}
