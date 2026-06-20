// A short, generic one-line hint for a tool's arguments — no per-tool knowledge.
// Prefers a salient key (the thing a tool usually acts on), else the first short
// scalar value. Used by the generic fallback header so an unregistered tool still
// says *what* it did. Mirrors WorkerToolCard's pendingInputSummary.
const SALIENT_KEYS = ["file_path", "path", "command", "query", "pattern", "url", "name", "title"];
const MAX = 60;

function clip(s, n = MAX) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

const isScalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

export function argsSummary(input) {
  if (input == null || typeof input !== "object") return "";
  for (const k of SALIENT_KEYS) {
    const v = input[k];
    if (isScalar(v) && String(v).trim()) return clip(v);
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim() && v.length <= 80) return clip(v);
  }
  return "";
}
