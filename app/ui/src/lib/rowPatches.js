import { sameJson } from "./sameJson.js";

// Fold the daemon's state:patch row changes ({ resource, op, data }) for one
// list into it: an upsert replaces or appends the row, a remove ({ id }) drops it.
// A row that arrives unchanged keeps its object, and a list nothing changed in
// stays the same array, so memoized views skip rows a patch did not touch.
export function mergeRowChanges(rows, changes, resource) {
  let byId = null;
  for (const c of changes) {
    if (c?.resource !== resource || !c.data?.id) continue;
    byId ??= new Map(rows.map((r) => [r.id, r]));
    if (c.op === "remove") byId.delete(c.data.id);
    else if (!sameJson(byId.get(c.data.id), c.data)) byId.set(c.data.id, c.data);
  }
  if (!byId) return rows;
  const out = [...byId.values()];
  return out.length === rows.length && out.every((r, i) => r === rows[i]) ? rows : out;
}
