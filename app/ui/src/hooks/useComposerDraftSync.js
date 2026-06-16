import { useEffect, useRef } from "react";
import { getDraft, saveDraft } from "../state/composerDrafts.js";

// Save-on-leave / restore-on-enter for the per-agent composer draft. On a
// switch React runs the cleanup (save under the old key) before the new
// effect (restore). The cleanup reads captureRef.current — already rebound by
// the new render, but still capturing the OLD agent's input: text/attachments/
// modes only change via restore, which runs after the save. Unmount (view tab
// switch) also saves, so drafts survive leaving the Code view.
export function useComposerDraftSync(key, capture, restore) {
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => {
    restoreRef.current(getDraft(key));
    return () => saveDraft(key, captureRef.current());
  }, [key]);
}
