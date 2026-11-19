// Each kind of Needs-you item: what its card shows and the actions it
// declares (03 §4.5). An action that answers is a write: it waits for the
// core and is held back while the core is unreachable. A kind with no card
// shows its title and summary with Open.

import { sendInboxDraft } from "../../../../state/eos/inboxStore.js";
import { openLocation } from "../../nav/eosNav.js";
import { ResultView } from "../results/ResultView.jsx";
import { PlainCard } from "./PlainCard.jsx";

// Opens the routine the item is about; answers nothing.
const openRoutine = {
  label: "Open",
  when: (detail) => Boolean(detail.item.routineId),
  run: (detail) => {
    openLocation(`eos:/routines/${encodeURIComponent(detail.item.routineId)}`);
    return false;
  },
};

const KINDS = {
  draft: {
    Body: ResultView,
    actions: [{ label: "Send", primary: true, write: true, run: (detail) => sendInboxDraft(detail.item.id) }],
  },
};

const PLAIN = { Body: PlainCard, actions: [openRoutine] };

export function cardOf(kind) {
  return KINDS[kind] ?? PLAIN;
}

// The actions the item offers, each with its label.
export function actionsOf(detail) {
  return cardOf(detail.item.kind).actions
    .filter((a) => !a.when || a.when(detail))
    .map((a) => ({ ...a, label: a.labelOf ? a.labelOf(detail) : a.label }));
}
