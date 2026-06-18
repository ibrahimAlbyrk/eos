// Pure path predicate: which text files offer a rendered-preview toggle in the
// file panel. Classification lives in one place (mirrors lib/fileKind.js), so a
// new previewable extension is a data-only change.

const MARKDOWN_EXTS = new Set(["md", "markdown"]);

export function isMarkdownPath(path) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTS.has(ext);
}
