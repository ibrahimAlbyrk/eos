export function findAll(text, query) {
  if (!query) return [];
  const lc = text.toLowerCase();
  const qLc = query.toLowerCase();
  const results = [];
  let idx = lc.indexOf(qLc);
  while (idx !== -1) {
    results.push(idx);
    idx = lc.indexOf(qLc, idx + 1);
  }
  return results;
}

export function shortenHome(p) {
  if (!p) return "";
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    return slash === -1 ? "~" : "~" + rest.slice(slash);
  }
  return p;
}
