// Persist the per-pane dock layout (slot structure + positional v{k}/c{k} ratios)
// across reloads, keyed by leaf id like cm:paneTree. Terminal slots are session-
// only — the PTY always opens clean and re-spawning one on every reload would
// surprise — so they are stripped on save and never restored.

const KEY = "cm:panelDocks";
const RATIO_KEY = /^[vc]\d+$/;

// Keep only the positional ratio keys (v{k}/c{k}); missing keys fall back to the
// geometry's per-key defaults, so an empty object is fine. Legacy single-column
// docks stored { v, col } — migrate them to { v0, c0 } so old layouts survive.
function normRatios(r) {
  const out = {};
  if (r && typeof r === "object") {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== "number") continue;
      if (k === "v") out.v0 = v;
      else if (k === "col") out.c0 = v;
      else if (RATIO_KEY.test(k)) out[k] = v;
    }
  }
  return out;
}

export function loadPanelDocks() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [paneId, dock] of Object.entries(raw)) {
      if (!dock || !Array.isArray(dock.slots)) continue;
      const slots = dock.slots.filter((s) => s && typeof s.type === "string");
      out[paneId] = {
        slots,
        nextSeq: typeof dock.nextSeq === "number" ? dock.nextSeq : slots.length,
        ratios: normRatios(dock.ratios),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function savePanelDocks(docks) {
  try {
    const out = {};
    for (const [paneId, dock] of Object.entries(docks)) {
      const slots = (dock.slots ?? []).filter((s) => s.type !== "terminal");
      if (!slots.length) continue;
      out[paneId] = { slots, nextSeq: dock.nextSeq ?? slots.length, ratios: normRatios(dock.ratios) };
    }
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // storage disabled or over quota — layout persistence is best-effort.
  }
}
