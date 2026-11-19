// Details kept by id, at most `limit`: the one put last is the newest, and the
// oldest goes first when the map is full. Object keys keep their insertion
// order for ids that are not numbers, which Eos ids never are.

export function putBounded(map, id, value, limit) {
  const { [id]: _, ...rest } = map;
  const next = { ...rest, [id]: value };
  const ids = Object.keys(next);
  for (const old of ids.slice(0, Math.max(0, ids.length - limit))) delete next[old];
  return next;
}

export function without(map, id) {
  const { [id]: _, ...rest } = map;
  return rest;
}
