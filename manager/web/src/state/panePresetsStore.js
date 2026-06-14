// Named split-layout presets — client-side only (localStorage), like
// cm:paneAgents. Each captures pane count + agents + focused pane; resize ratios
// stay a separate global preference. Agents that no longer exist restore as
// empty panes (PaneProvider.prunePanes / selectedId cleanup handle it).

const KEY = "cm:panePresets";

function load() {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

let presets = load();
const listeners = new Set();

function persist() {
  localStorage.setItem(KEY, JSON.stringify(presets));
  for (const fn of listeners) fn();
}

export function listPresets() {
  return presets;
}

export function savePreset(name, agents, focused) {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return;
  presets = [...presets, {
    id: crypto.randomUUID(),
    name: trimmed,
    agents: [...agents].map((x) => x ?? null),
    focused: focused ?? 0,
  }];
  persist();
}

export function removePreset(id) {
  presets = presets.filter((p) => p.id !== id);
  persist();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
