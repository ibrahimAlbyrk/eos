import { useCallback } from "react";
import { useUi } from "../../state/ui.jsx";
import { queueUrl } from "../../state/browserPanelStore.js";
import { useBrowserSessionKey } from "../browser/useBrowserSessionKey.js";
import { RELEASES_URL, releaseNotesUrl } from "../../lib/updates.js";

// A release's notes in the side panel's browser (its GitHub release page), or
// every release's with no version.
export function useOpenReleaseNotes() {
  const ui = useUi();
  const sessionKey = useBrowserSessionKey();
  return useCallback((version) => {
    ui.closeAllPops();
    queueUrl(sessionKey, version ? releaseNotesUrl(version) : RELEASES_URL);
    ui.openPanel("browser");
  }, [ui, sessionKey]);
}
