// Edits applied to a base input before validateView sees it. A path is a list of
// keys and indexes; every container on the way must exist.
//   ["set", path, value]                    set (or add) the value at path
//   ["del", path]                           remove the key or the list element
//   ["push", path, value]                   append to the list at path
//   ["splice", path, start, count, text]    in the string at path, replace `count`
//                                           UTF-16 units from `start` with text

export function applyOps(input, ops) {
  for (const [op, at, ...rest] of ops) {
    if (!at.length) {
      if (op !== "set") throw new Error(`${op} needs a path`);
      input = rest[0];
      continue;
    }
    let parent = input;
    for (const seg of at.slice(0, -1)) parent = step(parent, seg);
    const last = at[at.length - 1];
    step(parent, last);
    if (op === "set") Object.defineProperty(parent, last, { value: rest[0], enumerable: true, writable: true, configurable: true });
    else if (op === "del") Array.isArray(parent) ? parent.splice(last, 1) : delete parent[last];
    else if (op === "push" && Array.isArray(parent[last])) parent[last].push(rest[0]);
    else if (op === "splice" && typeof parent[last] === "string") parent[last] = parent[last].slice(0, rest[0]) + rest[2] + parent[last].slice(rest[0] + rest[1]);
    else throw new Error(`unknown op ${op}`);
  }
  return input;
}

// A list is addressed by index, an object by key; anything else is not a path.
function step(parent, seg) {
  const ok = Array.isArray(parent) ? Number.isInteger(seg) && seg >= 0 && seg <= parent.length : parent !== null && typeof parent === "object" && typeof seg === "string";
  if (!ok) throw new Error(`no ${JSON.stringify(seg)} in ${JSON.stringify(parent)?.slice(0, 40)}`);
  return parent[seg];
}

// The inverse of encode(): what a stored value stands for.
export function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    if ("$undef" in v) return undefined;
    if ("$rep" in v) return v.$rep[0].repeat(v.$rep[1]);
    if ("$cat" in v) return v.$cat.map(decode).join("");
    const out = {};
    for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: decode(x), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}
