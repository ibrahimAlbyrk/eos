// The Which slot (02's `Which`) as words and the parts the user can change:
// each test's value (a menu for what the item is or is not, a glob for paths, text for the
// rest) and the question a small model answers. Every change keeps the keys
// this version does not know.

const OPS = ["is", "in", "has", "glob", "contains", "gte", "lte"];
const OP_WORDS = { is: "is", in: "is one of", has: "has", glob: "matches", contains: "contains", gte: "is at least", lte: "is at most" };
// A yes-or-no fact reads as what the item is: "it is not a draft", "it is
// merged". A fact that is a noun takes its article.
const NOUNS = new Set(["draft", "bot", "fork"]);
const asIs = (fact) => (NOUNS.has(fact) ? `a ${fact}` : fact);
const isWords = (fact) => [{ value: "true", label: asIs(fact) }, { value: "false", label: `not ${asIs(fact)}` }];

const opOf = (rule) => OPS.find((op) => op in rule);

function testParts(rule, put, key) {
  const op = opOf(rule);
  if (!op) return ["a rule this version cannot read"];
  const v = rule[op];
  const set = (next) => put({ ...rule, [op]: next });
  const base = { key, label: rule.fact };
  let part;
  if (op === "is" && typeof v === "boolean") {
    const options = isWords(rule.fact);
    return ["it is ", { ...base, editor: "menu", text: options[v ? 0 : 1].label, value: String(v), options, apply: (x) => set(x === "true") }];
  } else if (op === "in" || Array.isArray(v)) {
    part = { ...base, editor: "text", text: (v ?? []).join(", "), value: (v ?? []).join(", "), apply: (x) => set(x.split(",").map((s) => s.trim()).filter(Boolean)) };
  } else if (op === "glob") {
    part = { ...base, editor: "glob", text: v, value: v, apply: set };
  } else if (op === "gte" || op === "lte" || (op === "is" && typeof v === "number")) {
    part = { ...base, editor: "text", text: String(v), value: String(v), check: (x) => (x !== "" && Number.isFinite(Number(x))) || "A number", apply: (x) => set(Number(x)) };
  } else {
    part = { ...base, editor: "text", text: String(v), value: String(v), apply: set };
  }
  // An item's changed files matched by a pattern read as what it touches.
  if (op === "glob" && (rule.fact === "paths" || rule.fact === "files")) return ["it touches ", part];
  return [`${rule.fact} ${OP_WORDS[op]} `, part];
}

// The parts of a rule; `put` takes its replacement, `key` names its place.
function ruleParts(rule, put, key) {
  if (!rule || typeof rule !== "object") return [];
  for (const [group, joiner] of [["all", " and "], ["any", " or "]]) {
    if (Array.isArray(rule[group])) {
      return rule[group].flatMap((child, n) => [
        ...(n > 0 ? [joiner] : []),
        ...ruleParts(child, (next) => put({ ...rule, [group]: rule[group].map((c, i) => (i === n ? next : c)) }), `${key}.${n}`),
      ]);
    }
  }
  if (rule.not) return ["not (", ...ruleParts(rule.not, (next) => put({ ...rule, not: next }), `${key}.not`), ")"];
  return testParts(rule, put, key);
}

export function whichParts(which) {
  const w = which ?? {};
  const parts = w.rule ? ["Items where ", ...ruleParts(w.rule, (rule) => ({ ...w, rule }), "rule")] : ["Every item"];
  const ask = w.ask ?? "";
  parts.push(ask ? ", then it asks: " : " ", {
    key: "ask",
    label: "Question",
    editor: "text",
    text: ask || "Add a question",
    value: ask,
    optional: !ask,
    add: !ask,
    apply: (v) => {
      const rest = { ...w };
      delete rest.ask;
      return v ? { ...rest, ask: v } : rest;
    },
  });
  return parts;
}
