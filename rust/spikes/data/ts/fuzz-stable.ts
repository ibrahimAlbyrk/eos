// Random JSON documents and their stableStringify output, one `{json, stable}`
// per line, for crates/eos-domain/examples/stable_check.rs. Seeded, so a failure reproduces.
import { stableStringify } from "../../../../core/src/domain/sync.ts";
import { randomBytes } from "./gen.ts";

const n = Number(process.argv[2] ?? 2000);
const pool = randomBytes("stable-fuzz", n * 512);
let at = 0;
const u8 = (): number => pool[at++ % pool.length];
const u32 = (): number => (u8() << 24 | u8() << 16 | u8() << 8 | u8()) >>> 0;
const f64 = (): number => { const b = Buffer.from([u8(), u8(), u8(), u8(), u8(), u8(), u8(), u8()]); const v = b.readDoubleBE(0); return Number.isFinite(v) ? v : 0; };
const CHARS = ["a", "Z", "0", " ", "\"", "\\", "/", "\n", "\t", "\u0000", "\u001f", "\u007f", "é", "İ", "ş", " ", "￿", "", "😀", "𐀀", "中"];
const str = (): string => Array.from({ length: u8() % 6 }, () => CHARS[u8() % CHARS.length]).join("");
const num = (): number => {
  switch (u8() % 6) {
    case 0: return u8() - 128;
    case 1: return u32() * (u8() % 2 ? 1 : -1);
    case 2: return f64();
    case 3: return (u32() / 1000) * 10 ** ((u8() % 60) - 30);
    case 4: return Number.MAX_SAFE_INTEGER - u8();
    default: return u32() * 4294967296 + u32();
  }
};
function value(depth: number): unknown {
  const k = u8() % (depth > 3 ? 5 : 8);
  if (k === 0) return null;
  if (k === 1) return u8() % 2 === 0;
  if (k === 2 || k === 3) return num();
  if (k === 4) return str();
  if (k === 5) return Array.from({ length: u8() % 5 }, () => value(depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = u8() % 6; i > 0; i--) o[str()] = value(depth + 1);
  return o;
}
for (let i = 0; i < n; i++) {
  const v = value(0);
  const json = JSON.stringify(v);
  console.log(JSON.stringify({ json, stable: stableStringify(JSON.parse(json)) }));
}
