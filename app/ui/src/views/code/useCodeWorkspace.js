import { useSyncExternalStore } from "react";
import { subscribe, getWorkspace } from "../../state/codeWorkspaceStore.js";

export function useCodeWorkspace() {
  return useSyncExternalStore(subscribe, getWorkspace);
}
