// Tiny path helpers (web-side; daemon does the heavy lifting).

export function basename(p) {
  if (!p) return "";
  const trimmed = String(p).replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

export function abbrev(p, max = 32) {
  if (!p) return "";
  if (p.length <= max) return p;
  return "…" + p.slice(-(max - 1));
}
