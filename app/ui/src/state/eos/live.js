// Eos's live topics (08 §4.2; the registry is 09 §4.4). useLive offers every
// stream event here before its own routing, whether or not an Eos screen was
// opened: a topic left to its fallthrough would refetch the workers list. A
// topic whose screen is not in this version is taken and left alone.

import { applyBlueprintChange, applyTrialChange, resyncBlueprints } from "./blueprintStore.js";
import { applyCapabilitiesChange, resyncCapabilities } from "./capabilitiesStore.js";
import { applyHalt, resyncHalt } from "./haltStore.js";
import { applyHomeRunChange, resyncHome } from "./homeStore.js";
import { applyInboxChange, applyInboxDelivery, resyncInbox } from "./inboxStore.js";
import { applyMemoryChange, applyMemoryRecalled, resyncMemory } from "./notesStore.js";
import { applyRoutineChange, resyncRoutines } from "./routinesStore.js";
import { applyRunActivity } from "./runLiveStore.js";
import { applyRunChange, applyRunsActive, resyncRuns } from "./runsStore.js";
import { applySignalsChange, resyncSignals } from "./signalsStore.js";

const ignored = () => {};
const both = (a, b) => (payload) => {
  a(payload);
  b(payload);
};

const HANDLERS = {
  "routine:change": both(applyRoutineChange, applyBlueprintChange),
  "run:change": (payload) => {
    applyRunChange(payload);
    applyTrialChange(payload);
    applyHomeRunChange();
  },
  "runs:active": applyRunsActive,
  "run:activity": applyRunActivity,
  "signals:change": applySignalsChange,
  "inbox:change": applyInboxChange,
  "inbox:delivery": applyInboxDelivery,
  "inbox:freedom": ignored,
  "inbox:halt": applyHalt,
  "memory:change": applyMemoryChange,
  "memory:recalled": applyMemoryRecalled,
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
  resyncBlueprints();
  resyncInbox();
  resyncCapabilities();
  resyncSignals();
  resyncHalt();
  resyncMemory();
  resyncHome();
}
