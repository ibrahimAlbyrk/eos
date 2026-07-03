import { useSyncExternalStore } from "react";
import { subscribe, listPresets } from "../state/panePresetsStore.js";

// Reactive list of saved split-layout presets (state/panePresetsStore). The
// server snapshot makes the hook renderToStaticMarkup-safe (PaneHeader tests).
export function usePanePresets() {
  return useSyncExternalStore(subscribe, listPresets, listPresets);
}
