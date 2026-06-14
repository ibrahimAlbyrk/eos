import { useSyncExternalStore } from "react";
import { subscribe, getInputNeeded } from "../state/inputNeededStore.js";

// Reactive read of the per-agent "needs input" flag (state/inputNeededStore).
export function useInputNeeded(workerId) {
  return useSyncExternalStore(subscribe, () => getInputNeeded(workerId));
}
