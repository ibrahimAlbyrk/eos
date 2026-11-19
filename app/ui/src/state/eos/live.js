// Eos's live topics (08 §4.2; the registry is 09 §4.4). useLive offers every
// stream event here before its own routing, whether or not an Eos screen was
// opened: a topic left to its fallthrough would refetch the workers list. A
// topic whose screen is not in this version is taken and left alone.

import { applyCapabilitiesChange, resyncCapabilities } from "./capabilitiesStore.js";
import { applyInboxChange, resyncInbox } from "./inboxStore.js";
import { applyRoutineChange, resyncRoutines } from "./routinesStore.js";
import { applyRunActivity } from "./runLiveStore.js";
import { applyRunChange, applyRunsActive, resyncRuns } from "./runsStore.js";

const ignored = () => {};

const HANDLERS = {
  "routine:change": applyRoutineChange,
  "run:change": applyRunChange,
  "runs:active": applyRunsActive,
  "run:activity": applyRunActivity,
  "signals:change": ignored,
  "inbox:change": applyInboxChange,
  "inbox:delivery": ignored,
  "inbox:freedom": ignored,
  "inbox:halt": ignored,
  "memory:change": ignored,
  "memory:recalled": ignored,
  "surfaces:change": ignored,
  "surfaces:issue": ignored,
  "surfaces:pins": ignored,
  "surfaces:design": ignored,
  "actions:record": ignored,
  "capabilities:change": applyCapabilitiesChange,
};

export const EOS_TOPICS = Object.keys(HANDLERS);

// True when the event was Eos's (useLive stops routing it).
export function applyEosEvent(reason, payload) {
  const handle = HANDLERS[reason];
  if (!handle) return false;
  handle(payload);
  return true;
}

// The stream could not replay what this window missed.
export function resyncEos() {
  resyncRoutines();
  resyncRuns();
  resyncInbox();
  resyncCapabilities();
}
