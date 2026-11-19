// Each kind of Needs-you item: what its card shows and the actions it
// declares (03 §4.5). An action that answers is a write: it waits for the
// core and is held back while the core is unreachable. A kind with no card
// shows its title and summary with Open.

import { answerInboxItem, decideRunAsk, decideSuggestion, sendInboxDraft } from "../../../../state/eos/inboxStore.js";
import { openLocation } from "../../nav/eosNav.js";
import { ResultView } from "../results/ResultView.jsx";
import { PermissionCard } from "./PermissionCard.jsx";
import { questionAnswers, QuestionCard } from "./QuestionCard.jsx";
import { AboutYouCard, PlainCard } from "./PlainCard.jsx";

const answer = (kind, choice, label, primary = false) => ({
  label,
  primary,
  write: true,
  run: (detail) => answerInboxItem(detail.item.id, { kind, choice }),
});

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
  question: {
    Body: QuestionCard,
    actions: [{
      label: "Send answers",
      primary: true,
      write: true,
      ready: (detail, values) => questionAnswers(detail, values) !== null,
      run: (detail, values) => answerInboxItem(detail.item.id, { kind: "question", answers: questionAnswers(detail, values) }),
    }],
  },
  permission: {
    Body: PermissionCard,
    actions: [
      { label: "Allow once", primary: true, write: true, run: (detail) => decideRunAsk(detail.item.id, detail.payload.pendingId, true) },
      { label: "Deny", write: true, run: (detail) => decideRunAsk(detail.item.id, detail.payload.pendingId, false) },
    ],
  },
  run_start: { Body: PlainCard, actions: [answer("run_start", "run", "Run", true), answer("run_start", "skip", "Skip")] },
  routine_alert: {
    Body: PlainCard,
    actions: [answer("routine_alert", "resume", "Resume", true), answer("routine_alert", "keep_paused", "Keep paused"), openRoutine],
  },
  confirm_change: { Body: PlainCard, actions: [answer("confirm_change", "confirm", "Confirm", true), answer("confirm_change", "reject", "Reject")] },
  notice: {
    Body: PlainCard,
    actions: [
      { ...answer("notice", "act", null, true), labelOf: (detail) => detail.payload?.actionLabel, when: (detail) => Boolean(detail.payload?.actionLabel) },
      answer("notice", "dismiss", "Dismiss"),
    ],
  },
  delivery_problem: {
    Body: PlainCard,
    actions: [
      answer("delivery_problem", "retry", "Try again", true),
      answer("delivery_problem", "mark_sent", "I sent it myself"),
      answer("delivery_problem", "discard", "Don't send"),
    ],
  },
  about_you: {
    Body: AboutYouCard,
    actions: [
      { label: "Yes, keep it", primary: true, write: true, run: (detail) => decideSuggestion(detail.item.id, detail.payload.memory.id, true) },
      { label: "No", write: true, run: (detail) => decideSuggestion(detail.item.id, detail.payload.memory.id, false) },
    ],
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
