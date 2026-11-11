// The form each function's result takes in a vector. Most are stored as they
// are; a few get a fixed key order or carry a derived value so one vector covers
// a helper too. The Rust harness builds the same form from its own result.

export const RECORDED = new Set([
  "parseMarkup", "parsePartial",
  "parsePartialJson", "parseLooseJson",
  "parseExpr", "checkExpr", "exprRefs", "evalExpr", "truthy", "hasTemplate", "fillTemplate",
  "parseWhere", "checkWhere", "matchWhere",
  "splitIds", "splitLabels", "parseCols", "parseChips", "parseOptions", "parseBest", "parseSort",
  "attrBool", "attrNum", "attrText", "dataRef",
  "validateView", "formatProblems", "statsLine", "isComponentName",
  "validateApp", "presentSuccessText", "appSuccessText", "genuiRejection",
]);

// Functions whose first argument must be a string on the Rust side.
const TEXT_FIRST = new Set([
  "parseMarkup", "parsePartial", "parsePartialJson", "parseLooseJson", "parseExpr", "checkExpr", "exprRefs",
  "evalExpr", "hasTemplate", "fillTemplate", "parseWhere", "checkWhere", "isComponentName", "appSuccessText", "presentSuccessText",
]);

// Why a recorded call cannot be a vector, or null when it can.
export function unsupported(fn, args) {
  if ((TEXT_FIRST.has(fn) || fn === "exprAll" || fn === "templateAll" || fn === "whereAll") && typeof args[0] !== "string") return "the Rust function takes text (the type rules a non-string out)";
  if (fn === "matchWhere" && typeof args[1] !== "string") return "called with a parsed filter";
  if (fn === "fillTemplate" && args[2] && args[2].formatNumber) return "called with a number formatter";
  if (fn === "truthy" && args[0] === undefined) return "undefined argument";
  return null;
}

function whereNode(n) {
  if ("of" in n) return { op: n.op, of: n.of.map(whereNode), not: n.not === true };
  const out = { op: n.op, not: n.not === true };
  for (const k of ["field", "lref", "value", "ref"]) if (n[k] !== undefined) out[k] = n[k];
  return out;
}

// Several functions over one input, stored as one vector (the corpus would be
// several times larger otherwise). `scopes` are the shared inputs in scopes.json.
export const COMPOSITES = {
  // Everything the expression language says about one source text.
  exprAll: (f, scopes, src) => ({
    parse: f.parseExpr(src),
    check: f.checkExpr(src),
    refs: f.exprRefs(src),
    value: f.evalExpr(src, scopes.expr),
    itemOnly: f.evalExpr(src, { item: scopes.expr.item }),
    bare: f.evalExpr(src),
  }),
  templateAll: (f, scopes, text) => ({ has: f.hasTemplate(text), filled: f.fillTemplate(text, scopes.expr), bare: f.fillTemplate(text) }),
  // One filter: how it parses, and whether each shared item passes it.
  whereAll: (f, scopes, src) => {
    const parsed = f.parseWhere(src);
    return {
      parse: parsed.ok ? { ok: true, node: whereNode(parsed.node), readsState: f.whereReadsState(parsed.node) } : { ok: false, error: parsed.error },
      check: f.checkWhere(src),
      matches: scopes.whereItems.map((item) => f.matchWhere(item, src, scopes.whereState)),
      stateless: scopes.whereItems.map((item) => f.matchWhere(item, src)),
    };
  },
  // Whether a boundary schema accepts an input.
  accepts: (f, _scopes, schema, input) => f[`${schema}Schema`].safeParse(input).success,
  // newViewId with a byte source that replays `bytes`; the family passes what the
  // TypeScript minted, the vector stores it as the result.
  viewIdFromBytes: (_f, _scopes, _bytes, id) => id,
  // Every attribute reader over one value.
  attrsAll: (f, _scopes, v) => ({
    ids: f.splitIds(v),
    labels: f.splitLabels(v),
    cols: f.parseCols(v),
    chips: f.parseChips(v),
    options: f.parseOptions(v),
    best: f.parseBest(v),
    sort: f.parseSort(v),
    bool: [f.attrBool(v), f.attrBool(v, true)],
    num: [f.attrNum(v), f.attrNum(v, 7)],
    text: [f.attrText(v), f.attrText(v, "fallback")],
  }),
};

export function canon(mods, fn, result) {
  if (fn === "parseMarkup" || fn === "parsePartial") {
    const labels = [];
    mods.markup.walkMarkup(result.nodes, (el) => labels.push(mods.markup.tagLabel(el)));
    return { nodes: result.nodes, errors: result.errors, depth: mods.markup.markupDepth(result.nodes), labels };
  }
  if (fn === "parseWhere") {
    return result.ok ? { ok: true, node: whereNode(result.node), readsState: mods.expr.whereReadsState(result.node) } : { ok: false, error: result.error };
  }
  return result;
}
