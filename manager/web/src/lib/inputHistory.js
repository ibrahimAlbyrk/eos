export const HISTORY_MAX = 100;

export function parseHistory(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => typeof e === "string").slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

// entries are newest-first; index null = not navigating.
// Navigation detaches implicitly: once the shown entry is edited, currentText
// no longer matches entries[index], so arrows fall back to default behavior
// without needing a dirty flag or input listener.
export function recallUp({ entries, index }, currentText) {
  if (index === null) {
    if (currentText !== "" || entries.length === 0) return { index: null, recalled: null };
    return { index: 0, recalled: entries[0] };
  }
  if (currentText !== entries[index]) {
    if (currentText === "") return { index: 0, recalled: entries[0] };
    return { index: null, recalled: null };
  }
  const next = Math.min(index + 1, entries.length - 1);
  return { index: next, recalled: entries[next] };
}

export function recallDown({ entries, index }, currentText) {
  if (index === null) return { index: null, recalled: null };
  if (currentText !== entries[index]) return { index: null, recalled: null };
  if (index === 0) return { index: null, recalled: "" };
  return { index: index - 1, recalled: entries[index - 1] };
}

export function commit(entries, text, max = HISTORY_MAX) {
  const t = text.trim();
  if (!t || entries[0] === t) return entries;
  return [t, ...entries].slice(0, max);
}
