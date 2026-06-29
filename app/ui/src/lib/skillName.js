// When a Read targets a SKILL.md, every skill's file is named identically, so
// the basename ("SKILL.md") collides across skills. Prefer the YAML frontmatter
// `name` instead — parsed from the read's already-in-payload result body, no
// disk read. Returns null to fall back to the basename on any miss (non-skill
// path, missing/unterminated frontmatter, no `name` key, malformed input).

import { basename } from "./path.js";
import { stripCatLineNumbers } from "./diff.jsx";

// Same frontmatter block shape as skillBody.js / commands.ts, capturing the body.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function frontmatterName(resultText) {
  if (!resultText) return null;
  try {
    const body = stripCatLineNumbers(resultText).map((l) => l.text).join("\n");
    const block = body.match(FRONTMATTER_RE);
    if (!block) return null;
    for (const line of block[1].split("\n")) {
      const m = line.match(/^name:\s*(.+)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "").trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

export function skillNameFromRead(filePath, resultText) {
  if (basename(filePath) !== "SKILL.md") return null;
  return frontmatterName(resultText);
}
