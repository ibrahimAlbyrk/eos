const TAB_EXTS = new Set(["go", "makefile"]);
const FOUR_SPACE_EXTS = new Set([
  "cs", "py", "java", "c", "h", "cpp", "cc", "cxx", "hpp",
  "rs", "swift", "kt", "php", "lua", "r", "pl",
]);

function fileKey(filePath) {
  const name = filePath?.split("/").pop().toLowerCase() ?? "";
  return name.includes(".") ? name.split(".").pop() : name;
}

// Scans leading whitespace: tab-indented lines vote for "\t", positive
// indent steps between consecutive non-blank lines vote for a space width.
function detectFromContent(content) {
  let tabLines = 0;
  const steps = new Map();
  let prevWidth = 0;
  let scanned = 0;
  for (const line of content.split("\n")) {
    if (scanned++ > 2000) break;
    if (!line.trim()) continue;
    if (line[0] === "\t") { tabLines++; continue; }
    const width = line.length - line.trimStart().length;
    const step = width - prevWidth;
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    prevWidth = width;
  }
  let bestStep = 0;
  let bestCount = 0;
  for (const [step, count] of steps) {
    if (count > bestCount || (count === bestCount && step < bestStep)) {
      bestStep = step;
      bestCount = count;
    }
  }
  if (tabLines > bestCount) return "\t";
  if (bestCount > 0) return " ".repeat(bestStep);
  return null;
}

export function detectIndentUnit(content, filePath) {
  const detected = detectFromContent(content ?? "");
  if (detected) return detected;
  const key = fileKey(filePath);
  if (TAB_EXTS.has(key)) return "\t";
  return FOUR_SPACE_EXTS.has(key) ? "    " : "  ";
}
