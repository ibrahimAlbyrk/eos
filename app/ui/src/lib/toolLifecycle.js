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

export function deriveToolLifecycle(events) {
  const jsonlResults = new Map();
  const doneResults = new Map();
  const done = new Set();
  let turnBarrier = -1;
  let exitBarrier = -1;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "jsonl") {
      const p = parsePayload(ev.payload);
      if (p.kind === "tool_result" && p.toolUseId) {
        jsonlResults.set(p.toolUseId, { text: p.text ?? "", isError: p.isError === true, patch: p.patch ?? null });
      }
      continue;
    }
    if (ev.type === "tool_done") {
      const p = parsePayload(ev.payload);
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

function isTurnBarrier(ev) {
  if (ev.type === "hook") {
    const e = parsePayload(ev.payload).event;
    return e === "Stop" || e === "SessionEnd";
  }
  if (ev.type === "state") {
    const s = parsePayload(ev.payload).state;
    return s === "IDLE" || s === "ENDING" || s === "DONE";
  }
  if (ev.type === "lifecycle") {
    const ph = parsePayload(ev.payload).phase;
    return ph === "interrupted" || ph === "delivery_failed";
  }
  return false;
}

function isExitBarrier(ev) {
  if (ev.type === "exit") return true;
  if (ev.type === "lifecycle") return parsePayload(ev.payload).phase === "pty_exit";
  return false;
}
