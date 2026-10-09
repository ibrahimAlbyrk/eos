// "Save as page": an app becomes a markdown page — the summary, then the source
// in an html fence. Pages are notes, not a runtime (live apps inside Pages are
// not in v1), so the page keeps what the app is and how to rebuild it.

// A fence longer than any backtick run in the source, so the source can't close it.
export function fenceFor(source) {
  let longest = 0;
  for (const run of String(source).match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function appPageBody({ summary = "", html = "" } = {}) {
  const source = String(html).replace(/\s+$/, "");
  const fence = fenceFor(source);
  const lead = String(summary).trim();
  return `${lead ? `${lead}\n\n` : ""}${fence}html\n${source}\n${fence}\n`;
}
