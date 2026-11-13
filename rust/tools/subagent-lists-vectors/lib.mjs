// The dashboard's derivation of a conversation's subagents and artifacts, as
// today's code does it: the rows /workers/:id/subagent-events answers
// (manager/routes/subagent-events.ts) through app/ui/src/lib/messageParser.js,
// collectSubagents and collectArtifacts. Shared by generate.mjs and parity.mjs.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../..");
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { buildBlocks, applyRewinds, applyClears, applyRecalls } = await load("app/ui/src/lib/messageParser.js");
const { collectSubagents } = await load("app/ui/src/lib/subagentRuns.js");
const { collectArtifacts } = await load("app/ui/src/lib/artifactLink.js");
const { summarizeSubagent } = await load("app/ui/src/lib/subagentSummary.js");
const { sanitizeEventRowForDisplay } = await load("manager/shared/display-sanitize.ts");

// The daemon's selection, taken from its route file (the route's own imports
// pull in the whole daemon).
async function loadSelection() {
  const promptTypes = /export const PROMPT_EVENT_TYPES[^=]*=\s*(\[[\s\S]*?\]);/
    .exec(readFileSync(path.join(REPO, "manager/routes/prompt-events.ts"), "utf8"))?.[1];
  if (!promptTypes) throw new Error("PROMPT_EVENT_TYPES not found in manager/routes/prompt-events.ts");
  const src = readFileSync(path.join(REPO, "manager/routes/subagent-events.ts"), "utf8")
    .replace(/^import \{ writeJson \}.*$/m, "")
    .replace(/^import \{ sanitizeEventRowForDisplay \}.*$/m, "")
    .replace(/^import \{ PROMPT_EVENT_TYPES \}.*$/m, `const PROMPT_EVENT_TYPES = ${promptTypes};`);
  if (!src.includes("export function selectSubagentRows")) throw new Error("selectSubagentRows not found");
  const dir = mkdtempSync(path.join(tmpdir(), "subagent-lists-"));
  try {
    const file = path.join(dir, "selection.ts");
    writeFileSync(file, src);
    return (await import(pathToFileURL(file).href)).selectSubagentRows;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const selectSubagentRows = await loadSelection();

// What /workers/:id/subagent-events answers for a log (rows from time 0 on).
export const subagentEvents = (log) =>
  selectSubagentRows(log.filter((r) => r.ts > 0)).map(sanitizeEventRowForDisplay);

// What the dashboard lists from that answer.
export function listsOf(rows, bootPromptOffset) {
  const blocks = buildBlocks(applyRecalls(applyRewinds(applyClears(rows), { bootPromptOffset })));
  return { subagents: collectSubagents(blocks).map(summarizeSubagent), artifacts: collectArtifacts(blocks) };
}


// The full subagent (prompt, report, every tool) the detail view shows, from
// any rows: identity left out (it follows from the list's order).
export function subagentOf(rows, bootPromptOffset, callId) {
  const blocks = buildBlocks(applyRecalls(applyRewinds(applyClears(rows), { bootPromptOffset })));
  const found = collectSubagents(blocks).find((s) => s.runs.some((r) => r.toolUseId === callId));
  if (!found) return null;
  const strip = ({ identity, ...rest }) => rest;
  return { ...strip(found), runs: found.runs.map(strip) };
}
