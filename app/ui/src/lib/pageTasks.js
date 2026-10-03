// Checklist counts of a page body ("- [ ]" / "- [x]"), skipping fenced code —
// the same rule the daemon's page summaries use (core/src/domain/page.ts).
export function countTasks(body) {
  let total = 0;
  let done = 0;
  let fenced = false;
  for (const line of String(body ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = !fenced && line.match(/^\s*[-*+]\s+\[([ xX])\]\s/);
    if (!m) continue;
    total += 1;
    if (m[1] !== " ") done += 1;
  }
  return { total, done };
}
