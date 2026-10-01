// Every subagent gets a little identity — a glyph and a color — so a batch of
// them reads as a cast of distinct mini agents in the transcript, the side panel
// and the Environment popover. Picked from the subagent's id (stable across
// reloads), then stepped past whatever its recent neighbours took, so no two of
// any 8 consecutive subagents share a color or a glyph.

export const SUBAGENT_COLORS = [
  { id: "iris", hex: "#a99bff" },
  { id: "mint", hex: "#5fd3a6" },
  { id: "amber", hex: "#f2b866" },
  { id: "coral", hex: "#ff8e7f" },
  { id: "sky", hex: "#6cb8ff" },
  { id: "rose", hex: "#f08cc8" },
  { id: "lime", hex: "#b6d662" },
  { id: "teal", hex: "#54d0d6" },
];

export const SUBAGENT_GLYPHS = ["quad", "clover", "grid", "spark", "flower", "pinwheel", "triad", "orbit"];

// FNV-1a, salted so color and glyph don't move in lockstep.
function hash(str, salt) {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickFree(start, taken, n) {
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!taken.has(i)) return i;
  }
  return start % n;
}

// ids in spawn order → Map(id → { color, hex, glyph }). An earlier subagent's
// identity never depends on a later one, so appending keeps every existing pick.
export function assignIdentities(ids) {
  const out = new Map();
  const recent = [];
  for (const id of ids) {
    const c = pickFree(hash(id, 0x9e37), new Set(recent.map((r) => r.c)), SUBAGENT_COLORS.length);
    const g = pickFree(hash(id, 0x85eb), new Set(recent.map((r) => r.g)), SUBAGENT_GLYPHS.length);
    recent.push({ c, g });
    if (recent.length >= SUBAGENT_COLORS.length) recent.shift();
    out.set(id, { color: SUBAGENT_COLORS[c].id, hex: SUBAGENT_COLORS[c].hex, glyph: SUBAGENT_GLYPHS[g] });
  }
  return out;
}
