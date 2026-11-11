// Parses what the Rust libraries wrote (yaml-probe-diff --emit) with the `yaml`
// package: a file written by the Rust app must read the same in today's app.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { parse } from "yaml";

const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as Array<{ lib: string; kind: string; name: string; text: string; parsed: unknown }>;
const tally: Record<string, { docs: number; same: number; differ: string[] }> = {};
for (const r of rows) {
  const t = (tally[r.lib] ??= { docs: 0, same: 0, differ: [] });
  t.docs++;
  let back: unknown;
  try { back = parse(r.text) ?? null; } catch { back = Symbol("refused"); }
  // JSON round trip so 1 and 1.0, and key order, compare as data.
  if (typeof back !== "symbol" && isDeepStrictEqual(JSON.parse(JSON.stringify(back)), r.parsed)) t.same++;
  else if (r.kind === "probe") t.differ.push(r.name);
  else t.differ.push(`(${r.kind})`);
}
for (const [lib, t] of Object.entries(tally)) console.log(`${lib}: ${t.same}/${t.docs} read back equal by yaml(npm)${t.differ.length ? " — differ: " + [...new Set(t.differ)].join(", ") : ""}`);
