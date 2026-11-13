#!/usr/bin/env node
// Parity of the core's conversation-wide summaries with the dashboard's own
// derivation, over what `subagent_lists_dump` wrote for a data folder:
//
//   cargo run --release -p eos-app --example subagent_lists_dump -- <data copy> <dump>
//   node rust/tools/subagent-lists-vectors/parity.mjs <dump>
//
// For each chat: /subagents and /artifacts against collectSubagents /
// collectArtifacts over today's /subagent-events answer, and each subagent's
// /subagents/:callId/events rows against the whole answer (the full subagent,
// prompt, report and every tool, as the detail view shows it). Prints counts
// and where a difference is (chat number, call id, field path), never values.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listsOf, subagentOf } from "./lib.mjs";

const dir = process.argv[2];
if (!dir) throw new Error("usage: parity.mjs <dump dir>");

// The first path where two values differ.
function diffPath(a, b, at = "") {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && a.length !== b.length) return `${at}.length ${a.length}≠${b.length}`;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = diffPath(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return at || "(root)";
}

const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
const totals = { chats: 0, withSubagents: 0, subagents: 0, artifacts: 0, details: 0 };
const differences = [];
for (const file of files) {
  const n = parseInt(file);
  const d = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const w = d.worker ?? {};
  const bootPromptOffset = w.parent_id && w.prompt ? 1 : 0;
  const ours = listsOf(d.subagentEvents, bootPromptOffset);
  totals.chats++;
  if (ours.subagents.length) totals.withSubagents++;
  totals.subagents += ours.subagents.length;
  totals.artifacts += ours.artifacts.length;
  const sub = diffPath(d.subagents, ours.subagents, "subagents");
  if (sub) differences.push(`chat ${n}: ${sub}`);
  const art = diffPath(d.artifacts, ours.artifacts, "artifacts");
  if (art) differences.push(`chat ${n}: ${art}`);
  for (const [call, rows] of Object.entries(d.subagentRows ?? {})) {
    totals.details++;
    const whole = subagentOf(d.subagentEvents, bootPromptOffset, call);
    const alone = subagentOf(rows, 0, call);
    const detail = diffPath(alone, whole, "detail");
    if (detail) differences.push(`chat ${n}: ${call} ${detail}`);
  }
}
console.log(JSON.stringify(totals));
console.log(differences.length ? differences.join("\n") : "no differences");
process.exitCode = differences.length ? 1 : 0;
