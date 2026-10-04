// The single cue a sidebar row shows on its right edge. The most urgent wins:
// blocked on the user > unread output > running. null means nothing is
// pressing, so the row shows how long ago it last worked instead of "idle".

import { statusFromState } from "./format.js";

const RANK = { input: 3, unread: 2, running: 1 };

// ctx = { waiting(worker) → bool, unread(worker) → bool }
export function ownSignal(node, ctx) {
  if (ctx.waiting(node)) return "input";
  if (ctx.unread(node)) return "unread";
  return statusFromState(node.state).dot === "run" ? "running" : null;
}

export function strongest(a, b) {
  return (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b;
}

// A folded parent or project surfaces the strongest cue anywhere beneath it,
// so a blocked sub-agent can't hide inside a collapsed row.
export function subtreeSignal(node, ctx) {
  let s = ownSignal(node, ctx);
  for (const c of node.children ?? []) s = strongest(s, subtreeSignal(c, ctx));
  return s;
}
