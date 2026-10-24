import { useCallback } from "react";
import { nameOf } from "../../lib/agentName.js";

// A job's chat by name; one no longer in the list (archived) still reads as a chat.
export function useChatName(live) {
  const workers = live.workers;
  return useCallback((workerId) => {
    const w = workers.find((x) => x.id === workerId);
    return w ? nameOf(w) : "Archived chat";
  }, [workers]);
}
