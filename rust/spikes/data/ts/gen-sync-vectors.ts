// Writes fixtures/sync/vectors.json from the TypeScript sync code, with a sync
// key invented here: derived ids, record names, sealed records (envelope v1) and
// stableStringify outputs for awkward JSON.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stableStringify } from "../../../../core/src/domain/sync.ts";
import { deriveSyncKeys, formatSyncKey, parseSyncKey } from "../../../../infra/src/sync/sync-key.ts";
import { randomBytes } from "./gen.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: gen-sync-vectors.ts <fixtures/sync>");
mkdirSync(out, { recursive: true });

const identity = { relayUrl: "wss://relay.example.test/eos", secret: new Uint8Array(randomBytes("sync-spike-secret", 32)) };
const syncKey = formatSyncKey(identity);
if (!parseSyncKey(syncKey)) throw new Error("the key does not parse");
const keys = deriveSyncKeys(identity.secret);

const envelopes = [
  { v: 1, domain: "page", id: "p_7Hq2", changedAt: 1_800_000_000_123, device: "ab12cd34", data: { title: "Günlük ✓", body: "# Başlık\n\nİçerik — “quoted” 😀\n", tags: ["a", "b"], rev: 3 } },
  { v: 1, domain: "memory", id: "m-1", changedAt: 1_800_000_000_456, device: "ab12cd34", deleted: true },
  { v: 1, domain: "profile", id: "profile", changedAt: 1.5, device: "", data: {} },
  { v: 1, domain: "template", id: "nested/dir/file name.md", changedAt: 0, device: "d", data: { text: "x".repeat(20_000) } },
];
const records = envelopes.map((envelope) => {
  const recordKey = keys.crypto.recordKey(envelope.domain, envelope.id);
  const plaintext = JSON.stringify(envelope);
  const sealed = Buffer.from(keys.crypto.seal(recordKey, new TextEncoder().encode(plaintext)));
  return { domain: envelope.domain, id: envelope.id, recordKey, plaintext, sealed: sealed.toString("base64") };
});

// JSON texts, parsed and then run through stableStringify.
const stableInputs = [
  `{"b":1,"a":2}`,
  `{"z":{"b":[3,{"d":1,"c":2}],"a":null},"a":[[],{},[[1,2],[{"y":1,"x":2}]]]}`,
  `{"10":1,"9":2,"1":3,"a":4,"B":5,"_":6,"":7}`,
  `{"～":1,"😀":2,"":3,"é":4,"é":5,"z":6,"𐀀":7,"￿":8}`,
  `[0,-0,1.0,1e21,1e-7,100000000000000000000,123456789012345680000,9007199254740993,0.1,0.30000000000000004,5e-324,1.7976931348623157e308,1E3,-1e-7,1.5e300,0.000001,0.0000001,1800000000123,-1800000000123.5,4.35,2.5e-5,1e100]`,
  `{"s":"quote \\" backslash \\\\ slash / tab \\t nl \\n cr \\r bs \\b ff \\f nul \\u0000 esc \\u001b del \\u007f ls \\u2028 ps \\u2029 emoji \\ud83d\\ude00 tr İıŞş"}`,
  `{"key \\" with \\n escapes":true,"k\\u0001":false}`,
  `{"a":{"a":{"a":{"a":{"a":{"b":[null,true,false,"",0]}}}}}}`,
  `"just a string"`,
  `null`,
  `[]`,
  `{}`,
  `{"dup":1,"dup":2}`,
  `{"__proto__":{"x":1},"constructor":2,"toString":3}`,
];
const stable = stableInputs.map((json) => {
  const text = stableStringify(JSON.parse(json));
  return { json, stable: text, hash: keys.crypto.hash(text) };
});

writeFileSync(join(out, "vectors.json"), JSON.stringify({
  note: "invented key; nothing here opens a real vault",
  syncKey,
  relayUrl: identity.relayUrl,
  secretSha256: createHash("sha256").update(identity.secret).digest("hex"),
  vaultId: keys.vaultId,
  authToken: keys.authToken,
  records,
  stable,
}, null, 1) + "\n");
console.log(JSON.stringify({ records: records.length, stable: stable.length }));
