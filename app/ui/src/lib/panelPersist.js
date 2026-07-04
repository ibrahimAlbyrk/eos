// Persist the per-pane dock layout (slot structure + {v, col} ratios) across
// reloads, keyed by leaf id like cm:paneTree. Terminal slots are session-only —
// the PTY always opens clean and re-spawning one on every reload would surprise —
// so they are stripped on save and never restored.

const KEY = "cm:panelDocks";
const DEFAULT_RATIOS = { v: 0.5, col: 0.5 };

function normRatios(r) {
  return {
    v: typeof r?.v === "number" ? r.v : DEFAULT_RATIOS.v,
    col: typeof r?.col === "number" ? r.col : DEFAULT_RATIOS.col,
  };
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
