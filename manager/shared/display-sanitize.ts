// The one display-sanitization step every daemon egress boundary funnels a copy
// through, so no user-visible surface renders an <agent_message>/<system_message>
// wrapper — whether stored at-rest (lifecycle:message_received) or echoed by the
// model into its own text/tool args. /events (HTTP → get_worker), the SSE
// broadcaster, and the HTML export all call this; it never mutates stored rows,
// so the DB stays resume-faithful. The model-facing delivery path keeps its tags.

import { stripSenderTags } from "../../core/src/domain/sender-tag.ts";
import type { WorkerEventRow } from "../../contracts/src/events.ts";

// Only recurse into plain objects/arrays — a Date, Map, or class instance in a
// live bus payload passes through untouched (copying it structurally would corrupt
// it, and it cannot carry a wrapper we'd render anyway).
function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Deep display copy: every string run through stripSenderTags, structure rebuilt.
export function sanitizeForDisplay(value: unknown): unknown {
  if (typeof value === "string") return stripSenderTags(value);
  if (Array.isArray(value)) return value.map(sanitizeForDisplay);
  if (value && typeof value === "object" && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeForDisplay(v);
    return out;
  }
  return value;
}

// Row form: payload is the raw JSON string stored in SQLite. Fast-path rows with
// no reserved-tag substring (the overwhelming majority) so they skip parse+
// stringify entirely; otherwise sanitize a parsed copy and re-serialize. The
// input row is never mutated.
export function sanitizeEventRowForDisplay(row: WorkerEventRow): WorkerEventRow {
  const p = row.payload;
  if (p == null || (!p.includes("agent_message") && !p.includes("system_message"))) {
    return row;
  }
  try {
    return { ...row, payload: JSON.stringify(sanitizeForDisplay(JSON.parse(p))) };
  } catch {
    return { ...row, payload: stripSenderTags(p) };
  }
}
