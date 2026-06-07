// Verification verdict derivation — advisory only, never blocks anything.
// Parses the agent's own `/verify` output and Handover lines out of the loaded
// event window. Honesty model: default is "unverified"; a verdict found in the
// transcript is invalidated back to unverified the moment any later mutating
// tool runs (the code changed after the check). Falling out of the 500-event
// window therefore degrades safely — we can show Unverified, never false green.

import { parsePayload } from "./messageParser.js";

// Worst-wins ordering when one report contains several check lines.
const SEVERITY = { failed: 4, blocked: 3, flaky: 2, passed: 1 };

const VERIFY_LINE = /^verify:\s*(.+?)\s*->\s*(passed|failed|blocked|flaky)\b/gim;
const HANDOVER_LINE = /\bverified by\s+(.+?)\s*[:—-]?\s*\b(passed|failed|blocked|flaky|unverified)\b/i;

const MUTATING_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);

function verdictFromText(text) {
  let worst = null;
  let command = null;
  VERIFY_LINE.lastIndex = 0;
  let m;
  while ((m = VERIFY_LINE.exec(text))) {
    const v = m[2].toLowerCase();
    if (!worst || SEVERITY[v] > SEVERITY[worst]) { worst = v; command = m[1]; }
  }
  if (worst) return { verdict: worst, command };
  const h = HANDOVER_LINE.exec(text);
  if (h) return { verdict: h[2].toLowerCase(), command: h[1] };
  return null;
}

// Per-child verdicts for the orchestrator hub: each worker_report carries the
// worker's Handover / verify lines — the latest report per child wins. This is
// what lets the user judge a whole fleet from the orchestrator screen without
// visiting each worker.
export function deriveChildVerdicts(events) {
  const map = {};
  for (const ev of events) {
    if (ev.type !== "worker_report") continue;
    const p = parsePayload(ev.payload);
    if (!p.fromWorker || !p.text) continue;
    const v = verdictFromText(p.text);
    if (v) map[p.fromWorker] = { ...v, ts: ev.ts };
  }
  return map;
}

export function deriveVerdict(events) {
  let found = null; // { verdict, command, ts }
  for (const ev of events) {
    if (ev.type === "jsonl") {
      const p = parsePayload(ev.payload);
      if (p.kind === "assistant_text" && p.text) {
        const v = verdictFromText(p.text);
        if (v) found = { ...v, ts: ev.ts };
        continue;
      }
      // Edits after the last verdict make it stale.
      if (p.kind === "tool_use" && found && ev.ts > found.ts && MUTATING_TOOLS.has(p.name)) {
        found = null;
      }
      continue;
    }
    if (ev.type === "tool_running" && found && ev.ts > found.ts) {
      const p = parsePayload(ev.payload);
      if (MUTATING_TOOLS.has(p.toolName)) found = null;
    }
  }
  return found ?? { verdict: "unverified", command: null, ts: null };
}
