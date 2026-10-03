// Fold the daemon's state:patch row changes ({ resource, op, data }) for one
// list into it: an upsert replaces or appends the row, a remove ({ id }) drops it.
export function mergeRowChanges(rows, changes, resource) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of changes) {
    if (c?.resource !== resource || !c.data?.id) continue;
    if (c.op === "remove") byId.delete(c.data.id);
    else byId.set(c.data.id, c.data);
  }
  return [...byId.values()];
}
