// localStorage-backed list of recently-used working directory paths.
// Capped to 5 entries; selected paths bubble to the top.

const RECENT_PATHS_KEY = "cm-recent-paths";
const RECENT_PATHS_CAP = 5;

export function loadRecentPaths() {
  try { return JSON.parse(localStorage.getItem(RECENT_PATHS_KEY) || "[]"); }
  catch { return []; }
}

export function pushRecentPath(path) {
  if (!path) return;
  try {
    const cur = loadRecentPaths();
    const next = [path, ...cur.filter((p) => p !== path)].slice(0, RECENT_PATHS_CAP);
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(next));
  } catch {}
}
