// Single source of truth for "is this tool still running?".
//
// A tool's terminal signal is its jsonl tool_result or a tool_done hook event.
// Both ride best-effort channels (hooks drop on daemon outage, transcripts stop
// at kill/crash), so a tool with neither must NOT shimmer forever: a turn-end
// barrier (Stop hook, IDLE/DONE state, interrupt, delivery_failed) closes every
// plain tool that started before it, and a worker exit closes everything —
// including background-agent inner tools, which legitimately outlive turns and
// are therefore exempt from turn barriers.

export function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === "string") {
    try { return JSON.parse(payload); } catch { return {}; }
  }
  return payload;
}

// A fetched row never changes (the events store replaces a patched row with a
// new object), so its payload is parsed once and every rebuild reuses it. The
// result is shared by every reader: treat it as read-only.
const parsedRows = new WeakMap();
export function rowPayload(row) {
  if (typeof row.payload !== "string") return parsePayload(row.payload);
  let p = parsedRows.get(row);
  if (p === undefined) {
    p = parsePayload(row.payload);
    parsedRows.set(row, p);
  }
  return p;
}

export function deriveToolLifecycle(events) {
  const jsonlResults = new Map();
  const doneResults = new Map();
  const done = new Set();
  let turnBarrier = -1;
  let exitBarrier = -1;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "jsonl") {
      const p = rowPayload(ev);
      if (p.kind === "tool_result" && p.toolUseId) {
        jsonlResults.set(p.toolUseId, { text: p.text ?? "", isError: p.isError === true, patch: p.patch ?? null });
      }
      continue;
    }
    if (ev.type === "tool_done") {
      const p = rowPayload(ev);
      if (p.toolUseId) {
        done.add(p.toolUseId);
        if ((p.result ?? "") !== "") {
          doneResults.set(p.toolUseId, { text: p.result, isError: p.isError === true });
        }
      }
      continue;
    }
    if (isTurnBarrier(ev)) turnBarrier = i;
    if (isExitBarrier(ev)) exitBarrier = i;
  }

  return {
    // jsonl tool_result wins over the hook-delivered copy (richer, exact text).
    resultOf: (id) => jsonlResults.get(id) ?? doneResults.get(id) ?? null,
    isDone: (id) => done.has(id),
    exitAfter: (idx) => exitBarrier > idx,
    /** A tool first seen at event index `idx` is closed when it has a terminal
     *  signal or a barrier landed after it. `turnExempt` skips the turn barrier
     *  (background-agent inner tools). */
    isClosed(id, idx, { turnExempt = false } = {}) {
      if (jsonlResults.has(id) || done.has(id)) return true;
      if (exitBarrier > idx) return true;
      if (!turnExempt && turnBarrier > idx) return true;
      return false;
    },
  };
}

export function isTurnBarrier(ev) {
  if (ev.type === "hook") {
    const e = rowPayload(ev).event;
    return e === "Stop" || e === "SessionEnd";
  }
  if (ev.type === "state") {
    const s = rowPayload(ev).state;
    return s === "IDLE" || s === "ENDING" || s === "DONE";
  }
  if (ev.type === "lifecycle") {
    const ph = rowPayload(ev).phase;
    return ph === "interrupted" || ph === "delivery_failed";
  }
  return false;
}

export function isExitBarrier(ev) {
  if (ev.type === "exit") return true;
  if (ev.type === "lifecycle") return rowPayload(ev).phase === "pty_exit";
  return false;
}
