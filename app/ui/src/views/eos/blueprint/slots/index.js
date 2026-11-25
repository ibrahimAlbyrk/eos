// The blueprint card's rows: what a run takes, then the seven slots. Each
// row says its slot in words with the parts the user can change; a part's
// `apply` answers the slot's new value, keeping every key it does not touch.

import { goesToParts } from "./goesTo.js";
import { howParts } from "./how.js";
import { whenParts } from "./when.js";
import { whichParts } from "./which.js";
import { whoParts } from "./who.js";

const textPart = (key, label, value, put, empty) => ({ key, label, editor: "text", text: value || empty, value: value ?? "", apply: put });

export const SLOTS = [
  {
    key: "takes",
    label: "Takes",
    parts: (bp) => [textPart("label", "What a run takes", bp.takes?.label, (label) => ({ ...bp.takes, label }), "Nothing named yet")],
  },
  { key: "when", label: "When", parts: (bp, ctx) => whenParts(bp.when, { ...ctx, takes: bp.takes }) },
  { key: "which", label: "Which", parts: (bp) => whichParts(bp.which) },
  { key: "who", label: "Who", parts: (bp) => whoParts(bp.who) },
  { key: "how", label: "How", parts: (bp) => howParts(bp.how) },
  {
    key: "makes",
    label: "Makes",
    parts: (bp) => [textPart("description", "What it makes", bp.makes?.description, (description) => ({ ...bp.makes, description }), "Not said yet")],
  },
  { key: "goesTo", label: "Goes to", parts: (bp) => goesToParts(bp.goesTo, bp.makes) },
];

// The slot keys whose values differ between two blueprints.
export function changedSlots(a, b) {
  const keys = [...SLOTS.map((s) => s.key), "freedom"];
  return keys.filter((k) => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null));
}

// A slot said as plain text, as it reads with nothing to change.
export function slotText(slot, bp, ctx) {
  return slot.parts(bp ?? {}, ctx)
    .filter((p) => typeof p === "string" || (p.editor !== "act" && !p.optional))
    .map((p) => (typeof p === "string" ? p : p.break ? " · " : p.text))
    .join("")
    .replace(/( · )+/g, " · ")
    .replace(/^ · | · $/g, "")
    .trim();
}
