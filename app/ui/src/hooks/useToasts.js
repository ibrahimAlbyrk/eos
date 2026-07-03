import { useSyncExternalStore } from "react";
import { subscribe, getToasts } from "../state/toastStore.js";

// Reactive read of the live toast list (state/toastStore). Consumed by
// ToastViewport.
export function useToasts() {
  return useSyncExternalStore(subscribe, getToasts);
}
