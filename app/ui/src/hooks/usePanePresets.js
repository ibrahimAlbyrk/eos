import { useSyncExternalStore } from "react";
import { subscribe, listPresets } from "../state/panePresetsStore.js";

// Reactive list of saved split-layout presets (state/panePresetsStore).
export function usePanePresets() {
  return useSyncExternalStore(subscribe, listPresets);
}
