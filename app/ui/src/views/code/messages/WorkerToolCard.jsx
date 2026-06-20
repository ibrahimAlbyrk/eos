// Body + identity helpers for the orchestrator's worker-management MCP tools.
// These tools render through the SAME dispatcher as every other tool now: their
// header verbs come from WORKER_TOOL_SPECS and their body is WorkerToolBody,
// both registered in ./toolViews.jsx. This file owns only the result-JSON →
// readable-body logic and the durable worker-name resolution; the shared chrome
// (disclosure, failure badge) lives in ToolItem.

import { Fragment } from "react";
import { nameOf } from "../../../lib/agentName.js";
import { AgentLink } from "./AgentLink.jsx";

// `detail` → plain-text body. `rows` → a worker-keyed row list rendered with
// clickable AgentLinks (and serialized to the same text for the expand gate).
const BODIES = {
  mcp__orchestrator__spawn_worker: { detail: (t) => t.input?.prompt ?? "" },
  mcp__orchestrator__kill_worker: { detail: killWorkerDetail },
  mcp__orchestrator__message_worker: { detail: (t) => t.input?.text ?? "" },
  mcp__orchestrator__get_worker: { detail: getWorkerDetail },
  mcp__orchestrator__list_active_workers: { rows: listWorkersRows, emptyText: "No workers." },
  mcp__orchestrator__list_pending_permissions: { rows: pendingRows, emptyText: "No pending permissions." },
};

// The expanded body text for a worker tool — error text when the call failed,
// otherwise a readable summary of the tool's result JSON. Same plain-text
// design as spawn/message (rendered in the shared report-detail block).
export function workerToolDetailText(tool, workers) {
  const body = BODIES[tool.name];
  if (!body) return "";
  if (tool.result?.isError) return tool.result?.text ?? "";
  if (body.rows) return rowsToText(body.rows(tool, workers), body.emptyText);
  return body.detail?.(tool, workers) ?? "";
}

// Each row: { id, name, meta, sub }. Head = "name · meta", sub on its own line.
function rowsToText(rows, emptyText) {
  if (!rows) return "";
  if (rows.length === 0) return emptyText ?? "";
  return rows
    .map((r) => {
      const head = joinDot([r.name, r.meta]);
      return r.sub ? `${head}\n${r.sub}` : head;
    })
    .join("\n\n");
}

function clip(s, n = 140) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

const joinDot = (parts) => parts.filter(Boolean).join(" · ");

// Resolve a worker name from an id via the live list, using the shared nameOf.
function liveName(id, workers) {
  const live = id ? (workers ?? []).find((w) => w.id === id) : null;
  return live ? nameOf(live) : (id ?? "worker");
}

function listWorkersRows(tool, workers) {
  const res = parseResultJson(tool);
  if (!Array.isArray(res)) return null;
  // Prefer the name carried in the result snapshot (correct even for workers
  // that no longer exist); fall back to live resolution for old transcripts.
  // `def` rides the snapshot so a killed worker still shows its definition.
  return res.map((w) => ({
    id: w.id,
    name: w.name || liveName(w.id, workers),
    def: w.worker_definition ?? null,
    meta: w.state ?? "",
    sub: clip(w.prompt),
  }));
}

function getWorkerDetail(tool) {
  const res = parseResultJson(tool);
  const w = res && !Array.isArray(res) ? res.worker : null;
  if (!w) return "";
  const meta = joinDot([
    typeof w.cost_usd === "number" ? "$" + w.cost_usd.toFixed(4) : null,
    Array.isArray(res.events) ? `${res.events.length} events` : null,
  ]);
  return [joinDot([w.state, w.branch]), meta, clip(w.prompt)].filter(Boolean).join("\n");
}

function killWorkerDetail(tool) {
  const res = parseResultJson(tool);
  if (!res || Array.isArray(res)) return "";
  return joinDot([res.state, res.branch]);
}

function pendingRows(tool, workers) {
  const res = parseResultJson(tool);
  if (!Array.isArray(res)) return null;
  return res.map((p) => ({ id: p.worker_id, name: liveName(p.worker_id, workers), meta: p.tool ?? "", sub: pendingInputSummary(p.input) }));
}

function pendingInputSummary(input) {
  if (input == null) return "";
  if (typeof input === "string") return clip(input);
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? null;
  if (pick) return clip(pick);
  try { return clip(JSON.stringify(input)); } catch { return ""; }
}

function parseResultJson(tool) {
  const text = tool.result?.text ?? "";
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Count for the list tools' header label ("workers (3)") — null while running or
// when the result isn't yet a JSON array.
export function workerListCount(tool) {
  const res = parseResultJson(tool);
  return Array.isArray(res) ? res.length : null;
}

// Pull the acted-on worker's {id, name} from a tool's result JSON. Durable —
// stays correct after the worker leaves the live list (kill/message carry it at
// the top level; get_worker nests it under `worker`).
function resultRef(res) {
  if (!res || Array.isArray(res)) return null;
  const w = res.worker && typeof res.worker === "object" ? res.worker : res;
  return { id: w.id ?? null, name: w.name ?? null };
}

// Resolve the worker a tool acted on. The result snapshot (resultRef) is the
// durable name source once a killed worker drops out of the live list; the live
// list only supplies the current name (renames) and click-to-select.
export function workerIdentity(tool, workers) {
  const ref = resultRef(parseResultJson(tool));
  const id = tool.input?.id ?? ref?.id ?? null;
  const live = id ? (workers ?? []).find((w) => w.id === id) : null;
  const name = tool.input?.name ?? live?.name ?? ref?.name ?? id ?? "worker";
  return { id, name };
}

// Expanded body for the worker-management tools — the AgentLink rows for the
// list tools, the plain-text result summary otherwise. Receives `workers` from
// ToolItem (passed to every Detail) for click-to-select name resolution.
export function WorkerToolBody({ tool, workers }) {
  const body = BODIES[tool.name];
  const failure = tool.result?.isError;
  return (
    <div className="report-detail" style={{ marginLeft: 0 }}>
      {!failure && body?.rows
        ? <RowsBody rows={body.rows(tool, workers)} emptyText={body.emptyText} workers={workers} />
        : <div className="report-detail-text">{workerToolDetailText(tool, workers)}</div>}
    </div>
  );
}

// Same pre-wrap layout as the plain-text body, but each row's worker name is a
// click-to-select AgentLink — identical affordance to the header.
function RowsBody({ rows, emptyText, workers }) {
  if (!rows || rows.length === 0) return <div className="report-detail-text">{emptyText}</div>;
  return (
    <div className="report-detail-text">
      {rows.map((r, i) => (
        <Fragment key={r.id ?? i}>
          {i > 0 && "\n\n"}
          <AgentLink id={r.id} name={r.name} workers={workers} definition={r.def} />
          {r.meta ? ` · ${r.meta}` : ""}
          {r.sub ? `\n${r.sub}` : ""}
        </Fragment>
      ))}
    </div>
  );
}
