// Branch label truncation for the cramped composer git row. Character-count
// based (not CSS pixel ellipsis) because the requirement is a hard 16-char cap:
// longer names show the first 16 chars then an ellipsis. The full name lives in
// the element's title attribute.
export function truncateBranch(name, max = 16) {
  if (!name) return name;
  return name.length > max ? name.slice(0, max) + "…" : name;
}
