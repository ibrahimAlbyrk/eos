// Pure model for the structured predicate builder (branch / loop `until`). The
// predicate is the SAME shape the contract evaluates (PredicateSchema,
// contracts/src/workflow-node.ts) — config IS the predicate — so every op here
// returns a new predicate that round-trips through the contract unchanged. A
// predicate is NEVER a free string; the builder composes it from the closed op
// set. Kept React/DOM-free so it unit-tests like graphModel.js / portTypes.js.
//
//   eq{left:ref, right?}   — no `right` ⇒ "left is truthy"; right is a {{ref}} or literal
//   exists{ref}            — ref resolves to a non-null value
//   and{clauses[]} / or{clauses[]} — boolean composition (nestable)

export const PREDICATE_OPS = ["eq", "exists", "and", "or"];

// The eq right-hand side has three authoring modes, inferred from the value:
//   truthy  — no `right` key (left is truthy)
//   ref     — right is a string containing "{{" (resolved against bindings)
//   literal — right is a plain JSON literal (compared by ===)
export const RIGHT_MODES = ["truthy", "ref", "literal"];

// The default predicate a fresh branch/loop starts from.
export function defaultPredicate() {
  return { op: "eq", left: "" };
}

// Build an empty predicate for a given op, preserving nothing (op switch reset).
export function makePredicate(op) {
  switch (op) {
    case "exists":
      return { op: "exists", ref: "" };
    case "and":
      return { op: "and", clauses: [] };
    case "or":
      return { op: "or", clauses: [] };
    case "eq":
    default:
      return { op: "eq", left: "" };
  }
}

// Switch a predicate's op, carrying over what still applies (an eq `left` survives
// into an `exists` `ref` and vice-versa; and/or keep their clauses).
export function changeOp(pred, op) {
  if (pred.op === op) return pred;
  if (op === "exists") return { op: "exists", ref: pred.op === "eq" ? pred.left || "" : "" };
  if (op === "eq") return { op: "eq", left: pred.op === "exists" ? pred.ref || "" : "" };
  if (op === "and" || op === "or") {
    const clauses = pred.op === "and" || pred.op === "or" ? pred.clauses : [];
    return { op, clauses };
  }
  return makePredicate(op);
}

export function withLeft(pred, left) {
  return { ...pred, left };
}

export function withRef(pred, ref) {
  return { ...pred, ref };
}

// Which eq right-mode a predicate is in (see RIGHT_MODES).
export function rightMode(pred) {
  if (pred.op !== "eq") return "truthy";
  if (!("right" in pred) || pred.right === undefined) return "truthy";
  if (typeof pred.right === "string" && pred.right.includes("{{")) return "ref";
  return "literal";
}

// Switch the eq right-mode, seeding a sensible default value for the new mode.
export function withRightMode(pred, mode) {
  if (pred.op !== "eq") return pred;
  const next = { ...pred };
  if (mode === "truthy") delete next.right;
  else if (mode === "ref") next.right = typeof pred.right === "string" ? pred.right : "";
  else next.right = typeof pred.right === "string" && pred.right.includes("{{") ? "" : pred.right ?? "";
  return next;
}

// Set the eq right value. In "ref" mode the raw text is stored verbatim; in
// "literal" mode the text is coerced to its JSON-ish type (number/bool/null/string).
export function withRightValue(pred, rawText, mode = rightMode(pred)) {
  if (pred.op !== "eq") return pred;
  if (mode === "truthy") {
    const next = { ...pred };
    delete next.right;
    return next;
  }
  return { ...pred, right: mode === "literal" ? coerceLiteral(rawText) : rawText };
}

// "12" → 12, "true"/"false" → bool, "null" → null, else the string verbatim.
export function coerceLiteral(text) {
  if (typeof text !== "string") return text;
  const t = text.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return text;
}

// The text shown in a literal input for a stored right value (the inverse of coerce).
export function literalText(value) {
  if (value === null) return "null";
  if (value === undefined) return "";
  return String(value);
}

// ---- and / or clause editing ------------------------------------------------
export function addClause(pred, clause = defaultPredicate()) {
  if (pred.op !== "and" && pred.op !== "or") return pred;
  return { ...pred, clauses: [...pred.clauses, clause] };
}

export function removeClause(pred, index) {
  if (pred.op !== "and" && pred.op !== "or") return pred;
  return { ...pred, clauses: pred.clauses.filter((_, i) => i !== index) };
}

export function replaceClause(pred, index, clause) {
  if (pred.op !== "and" && pred.op !== "or") return pred;
  return { ...pred, clauses: pred.clauses.map((c, i) => (i === index ? clause : c)) };
}

// Is the predicate fully specified (no empty required field at any depth)? Drives
// the inspector's "incomplete" affordance; the backend schema is the hard gate.
export function isPredicateComplete(pred) {
  if (!pred || typeof pred !== "object") return false;
  switch (pred.op) {
    case "eq":
      return typeof pred.left === "string" && pred.left.trim() !== "";
    case "exists":
      return typeof pred.ref === "string" && pred.ref.trim() !== "";
    case "and":
    case "or":
      return Array.isArray(pred.clauses) && pred.clauses.length > 0 && pred.clauses.every(isPredicateComplete);
    default:
      return false;
  }
}
