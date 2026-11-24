// Each kind of Needs-you item: what its card shows and the actions it
// declares (03 §4.5). An action that answers is a write: it waits for the
// core and is held back while the core is unreachable. A kind with no card
// shows its title and summary with Open.

import { answerInboxItem, decideRunAsk, decideSuggestion, isHolding, sendInboxDraft } from "../../../../state/eos/inboxStore.js";
import { openLocation } from "../../nav/eosNav.js";
import { dropEdit } from "../editDrafts.js";
import { docChanged, sendLabel } from "../editors/editDoc.js";
import { currentEdit, DraftCard, isStale, originalDoc, pageOf } from "./DraftCard.jsx";
import { PermissionCard } from "./PermissionCard.jsx";
import { questionAnswers, QuestionCard } from "./QuestionCard.jsx";
import { editedGuess, MemoryQuestion } from "./MemoryQuestion.jsx";
import { PlainCard } from "./PlainCard.jsx";
import { CapabilityProblem, CapabilityProposal } from "./CapabilityCards.jsx";
import { FreedomOffer } from "./FreedomOffer.jsx";
import { checkCapability } from "../../../../state/eos/capabilitiesStore.js";

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
    Body: DraftCard,
    actions: [
      {
        label: "Send",
        primary: true,
        write: true,
        labelOf: (detail, values) => (isStale(detail) ? "Send anyway" : sendLabel(originalDoc(detail), currentEdit(detail, values))),
        run: async (detail, values) => {
          const edit = currentEdit(detail, values);
          const doc = docChanged(edit, originalDoc(detail)) ? edit : undefined;
          const sent = await sendInboxDraft(detail.item.id, doc, isStale(detail));
          if (sent) dropEdit(detail.item.id);
          // A send in its hold keeps its draft on screen, where it can be stopped.
          return sent && !isHolding(detail.item.id);
        },
      },
      {
        label: "Edit",
        // A page is edited on the page itself.
        when: (detail, values) => Boolean(originalDoc(detail)) && !pageOf(originalDoc(detail)) && !currentEdit(detail, values),
        run: (detail, values, setValue) => {
          setValue("edit", originalDoc(detail));
          return false;
        },
      },
    ],
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
      {
        label: "Try again",
        primary: true,
        write: true,
        // After Edit and retry, the result goes as the user edited it.
        run: (detail, values) => {
          const doc = docChanged(values.edit, originalDoc(detail)) ? values.edit : undefined;
          return answerInboxItem(detail.item.id, { kind: "delivery_problem", choice: "retry", ...(doc ? { doc } : {}) });
        },
      },
      {
        label: "Edit and retry",
        when: (detail, values) => Boolean(originalDoc(detail)) && values.edit === undefined,
        run: (detail, values, setValue) => {
          setValue("edit", originalDoc(detail));
          return false;
        },
      },
      answer("delivery_problem", "mark_sent", "I sent it myself"),
      answer("delivery_problem", "discard", "Don't send"),
    ],
  },
  freedom_offer: { Body: FreedomOffer, actions: [answer("freedom_offer", "accept", "Allow", true), answer("freedom_offer", "not_now", "Not now")] },
  capability_install: {
    Body: CapabilityProposal,
    actions: [answer("capability_install", "install", "Install", true), answer("capability_install", "decline", "Not now")],
  },
  capability_attention: {
    Body: CapabilityProblem,
    actions: [
      {
        label: "Check again",
        primary: true,
        write: true,
        when: (detail) => Boolean(detail.payload?.capabilityId),
        // The item stays until the core sees the capability working again.
        run: async (detail) => {
          await checkCapability(detail.payload.capabilityId);
          return false;
        },
      },
      {
        label: "Open",
        when: (detail) => Boolean(detail.payload?.capabilityId),
        run: (detail) => {
          openLocation(`eos:/capabilities/${encodeURIComponent(detail.payload.capabilityId)}`);
          return false;
        },
      },
    ],
  },
  about_you: {
    Body: MemoryQuestion,
    actions: [
      {
        label: "Yes, keep it",
        primary: true,
        write: true,
        ready: (detail, values) => values.text === undefined || Boolean(values.text.trim()),
        run: (detail, values) => decideSuggestion(detail.item.id, detail.payload.memory.id, true, editedGuess(detail, values)),
      },
      { label: "No", write: true, run: (detail) => decideSuggestion(detail.item.id, detail.payload.memory.id, false) },
      {
        label: "Edit",
        when: (detail, values) => values.text === undefined,
        run: (detail, values, setValue) => {
          setValue("text", detail.payload.memory.text);
          return false;
        },
      },
    ],
  },
};

const PLAIN = { Body: PlainCard, actions: [openRoutine] };

export function cardOf(kind) {
  return KINDS[kind] ?? PLAIN;
}

// The actions the item offers with what is on screen, each with its label.
export function actionsOf(detail, values = {}) {
  return cardOf(detail.item.kind).actions
    .filter((a) => !a.when || a.when(detail, values))
    .map((a) => ({ ...a, label: a.labelOf ? a.labelOf(detail, values) : a.label }));
}
