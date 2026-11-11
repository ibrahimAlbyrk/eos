// Side finding of the stableStringify fuzz: on Node 26.0.0 (V8 14.6.202.33)
// JSON.stringify writes some one-character object keys that need escaping (tab,
// NUL, the quote) as a backslash, so a document does not survive
// JSON.parse(JSON.stringify(v)). Bun 1.3.10 (JavaScriptCore) round-trips all of
// them; Node 24 (what the packaged daemon runs on) was not tested.
// Run: node ts/node26-json-roundtrip.mjs [documents]
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const n = Number(process.argv[2] ?? 20000);
const pool = Buffer.alloc(n * 512);
for (let i = 0, at = 0; at < pool.length; i++, at += 32) createHash("sha256").update(`stable-fuzz:${i}`).digest().copy(pool, at);
let at = 0;
const u8 = () => pool[at++ % pool.length];
const CHARS = ["a", "Z", "0", " ", "\"", "\\", "/", "\n", "\t", "\u0000", "\u001f", "\u007f", "é", "İ", "ş", " ", "￿", "", "😀", "𐀀", "中"];
const str = () => Array.from({ length: u8() % 6 }, () => CHARS[u8() % CHARS.length]).join("");
function value(depth) {
  const k = u8() % (depth > 3 ? 3 : 6);
  if (k === 0) return null;
  if (k === 1) return u8();
  if (k === 2) return str();
  if (k === 3) return Array.from({ length: u8() % 5 }, () => value(depth + 1));
  const o = {};
  for (let i = u8() % 6; i > 0; i--) o[str()] = value(depth + 1);
  return o;
}
let bad = 0, badKey = 0;
for (let i = 0; i < n; i++) {
  const v = value(0);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(v)), v)) bad++;
}
for (let i = 0; i < 2_000_000; i++) {
  const k = CHARS[u8() % CHARS.length];
  if (JSON.parse(JSON.stringify(k)) !== k) badKey++;
}
console.log(process.version, "v8", process.versions.v8, { docs: n, docsThatDoNotRoundTrip: bad, singleCharStringsThatDoNotRoundTrip: badKey });
