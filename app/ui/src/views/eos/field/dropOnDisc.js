// A file or link dropped on a disc (08 G18). D40: the drop starts the run at
// once with the routine's defaults, and its live line offers Stop for five
// seconds; the delivery still passes the routine's Freedom.

import { transport } from "../../../state/eos/transport.js";
import { takesItems } from "../runform/runFormModel.js";
import { homeForm } from "../input/runInput.js";

export const DROP_STARTS_AT_ONCE = true;

const article = (word) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);
const LINK = /^https?:\/\/\S+$/;

function matches(patterns, value) {
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(value);
    } catch {
      return false;
    }
  });
}

// The item a dropped value gives the routine, or why it refuses it.
export function droppedItem(routine, value) {
  const takes = routine.takes;
  if (!takesItems(takes)) return { refused: `${routine.name} takes nothing to work on.` };
  const patterns = takes.itemPatterns ?? [];
  if (patterns.length > 0 && !matches(patterns, value)) return { refused: `${routine.name} takes ${article(takes.label ?? "item")}.` };
  const name = value.replace(/\/$/, "").split("/").pop() || value;
  const item = LINK.test(value) ? { kind: takes.kind, url: value, title: value } : { kind: takes.kind, path: value, title: name };
  return { item: { ...item, untrusted: false } };
}

// The run form a drop starts: the defaults, with the dropped item.
export function dropForm(routine, item) {
  const form = homeForm(routine);
  return routine.takes.many ? { ...form, items: [item] } : { ...form, item };
}

// What was dropped: a link, else a file (its path, or its bytes kept by the
// core first). Null when nothing usable came.
export async function droppedValue(dataTransfer) {
  const link = (dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain") || "").split(/\r?\n/).find((l) => LINK.test(l.trim()));
  if (link) return link.trim();
  const file = dataTransfer.files?.[0];
  if (!file) return null;
  if (typeof file.path === "string" && file.path) return file.path;
  const r = await transport.upload(file).catch(() => null);
  return r?.ok && typeof r.body?.path === "string" ? r.body.path : null;
}
