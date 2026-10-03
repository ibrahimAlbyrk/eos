// The smallest single replacement turning `cur` into `next` (shared prefix and
// suffix untouched) — as a CodeMirror change it keeps the caret and scroll put.
export function minimalChange(cur, next) {
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start += 1;
  let end = 0;
  while (end < cur.length - start && end < next.length - start && cur[cur.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  return { from: start, to: cur.length - end, insert: next.slice(start, next.length - end) };
}
