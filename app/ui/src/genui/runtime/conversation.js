// Conversation-wide facts about visual answers, derived from the parsed blocks
// (Messages passes useConversationBlocks' list, not just the loaded window):
//   superseded  viewId → the later view that replaced it (present {replaces})
//   fixedBelow  callIds of refused calls a later successful view followed

import { isFinalInput, genuiKindOf, viewIdFromResult } from "./toolCall.js";

const VIEW_ID_RE = /^v_[A-Za-z0-9]{12}$/;

export function genuiIndex(blocks) {
  const superseded = new Map();
  const fixedBelow = new Set();
  let failed = [];
  for (const b of blocks ?? []) {
    if (b?.kind !== "view" || !b.tool) continue;
    const t = b.tool;
    if (t.result?.isError) {
      failed.push(t.id);
      continue;
    }
    const viewId = viewIdFromResult(t.result);
    if (!viewId) continue;
    for (const id of failed) fixedBelow.add(id);
    failed = [];
    const old = t.input?.replaces;
    if (typeof old === "string" && VIEW_ID_RE.test(old) && old !== viewId) {
      superseded.set(old, { by: viewId, title: typeof t.input?.title === "string" ? t.input.title : "" });
    }
  }
  // A signature so an unchanged index keeps its identity across re-parses.
  const key = `${[...superseded].map(([a, v]) => `${a}>${v.by}`).join(",")}|${[...fixedBelow].join(",")}`;
  return { key, superseded, fixedBelow };
}

// The keyed-memo form: returns `prev` when nothing changed.
export function stableGenuiIndex(blocks, prev) {
  const next = genuiIndex(blocks);
  return prev && prev.key === next.key ? prev : next;
}

// A view block whose finished tool call landed — its stream buffer can go.
export function isFinalViewBlock(b) {
  if (b?.kind !== "view" || b.live || !b.tool) return false;
  return isFinalInput(b.tool.input, genuiKindOf(b.tool.name) ?? "view") || b.tool.result != null;
}
