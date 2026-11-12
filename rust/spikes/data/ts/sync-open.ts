// Opens records sealed by Rust (crates/eos-sync-vault/tests/typescript.rs) with the TypeScript
// sync code, and parses each envelope with the real schema.
import { readFileSync } from "node:fs";

import { SyncEnvelopeSchema } from "../../../../contracts/src/sync.ts";
import { deriveSyncKeys, parseSyncKey } from "../../../../infra/src/sync/sync-key.ts";

const input = JSON.parse(readFileSync(0, "utf8")) as { syncKey: string; records: Array<{ domain: string; id: string; recordKey: string; sealed: string; plaintext: string }> };
const keys = deriveSyncKeys(parseSyncKey(input.syncKey)!.secret);
let opened = 0;
for (const r of input.records) {
  if (keys.crypto.recordKey(r.domain, r.id) !== r.recordKey) throw new Error(`record key differs for ${r.domain}/${r.id}`);
  const plain = new TextDecoder().decode(keys.crypto.open(r.recordKey, Buffer.from(r.sealed, "base64")));
  if (plain !== r.plaintext) throw new Error("plaintext differs");
  SyncEnvelopeSchema.parse(JSON.parse(plain));
  opened++;
}
let wrongNameRejected = false;
try { keys.crypto.open(input.records[1].recordKey, Buffer.from(input.records[0].sealed, "base64")); } catch { wrongNameRejected = true; }
console.log(JSON.stringify({ opened, wrongNameRejected }));
if (!wrongNameRejected) process.exit(1);
