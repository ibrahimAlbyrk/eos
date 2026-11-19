// Eos's live topics. useLive offers every stream event here before its own
// routing, whether or not an Eos screen was opened: a topic left to its
// fallthrough would refetch the workers list.

import { applyCapabilitiesChange, resyncCapabilities } from "./capabilitiesStore.js";

const HANDLERS = {
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
  resyncCapabilities();
}
