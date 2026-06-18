import { useEffect } from "react";
import { pruneExcept as pruneDiff } from "../state/diffStore.js";
import { pruneExcept as pruneConflict } from "../state/conflictStore.js";
import { pruneExcept as pruneGitStatus } from "../state/gitStatusStore.js";
import { pruneExcept as pruneTerminal } from "../state/terminalStore.js";
import { pruneExcept as pruneThinking } from "../state/thinkingStore.js";

// Per-worker caches (diff/conflict/git/terminal/thinking) are purged on explicit delete
// (useDeleteAgent), but a worker that auto-shutdowns, dies in a cascade, or
// vanishes on daemon restart never hits that path — its cached patch text /
// output strings would linger. One reconcile pass per workers update drops any
// entry whose worker has left the live list. Empty list is skipped (boot /
// reconnect blip) so a transient gap can't purge live caches.
export function useStorePrune(workers) {
  useEffect(() => {
    if (workers.length === 0) return;
    const present = new Set(workers.map((w) => w.id));
    pruneDiff(present);
    pruneConflict(present);
    pruneGitStatus(present);
    pruneTerminal(present);
    pruneThinking(present);
  }, [workers]);
}
