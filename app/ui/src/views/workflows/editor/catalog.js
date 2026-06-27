// Normalize the GET /workflows/catalog response into the palette model the editor
// renders. The daemon returns { nodeKinds: [{kind,label,category,description,
// inputs,outputs}], transformFns: [...] }. Pure + defensive so a partial/empty
// response never throws in render — an absent field degrades to a usable default.

const CATEGORY_ORDER = ["io", "compute", "transform", "control", "composite"];
const CATEGORY_LABEL = {
  io: "I/O",
  compute: "Compute",
  transform: "Transform",
  control: "Control",
  composite: "Composite",
};

function normalizePort(p) {
  return { name: String(p?.name ?? ""), type: typeof p?.type === "string" ? p.type : "any" };
}

function normalizeEntry(e) {
  return {
    kind: String(e?.kind ?? ""),
    label: e?.label || String(e?.kind ?? ""),
    category: e?.category || "compute",
    description: e?.description || "",
    inputs: Array.isArray(e?.inputs) ? e.inputs.map(normalizePort) : [],
    outputs: Array.isArray(e?.outputs) ? e.outputs.map(normalizePort) : [],
  };
}

export function normalizeCatalog(resp) {
  const kinds = Array.isArray(resp?.nodeKinds) ? resp.nodeKinds.map(normalizeEntry).filter((e) => e.kind) : [];
  const byKind = {};
  for (const e of kinds) byKind[e.kind] = e;
  const transformFns = Array.isArray(resp?.transformFns) ? resp.transformFns.map(String) : [];
  return { kinds, byKind, transformFns };
}

// Palette entries grouped into stable category sections for rendering. Categories
// appear in CATEGORY_ORDER; an unknown category sorts last under its own label.
export function paletteGroups(kinds) {
  const groups = new Map();
  for (const e of kinds) {
    if (!groups.has(e.category)) groups.set(e.category, []);
    groups.get(e.category).push(e);
  }
  const ordered = [...groups.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return ordered.map((cat) => ({
    category: cat,
    label: CATEGORY_LABEL[cat] || cat,
    entries: groups.get(cat),
  }));
}
