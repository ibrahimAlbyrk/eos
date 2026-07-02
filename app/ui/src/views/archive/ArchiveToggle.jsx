import { useSyncExternalStore } from "react";
import { subscribe, getArchive, toggleArchiveMode } from "../../state/archiveStore.js";

// Sidebar-level archive switch — sits directly above the Settings footer,
// same pill recipe. On: the sidebar shows archived agents and the main area
// the archive panel; off: back to the untouched normal state.
export function ArchiveToggle() {
  const { archiveMode } = useSyncExternalStore(subscribe, getArchive);
  return (
    <div className="sb-archive">
      <button
        className={`sb-settings__btn${archiveMode ? " on" : ""}`}
        onClick={toggleArchiveMode}
        title={archiveMode ? "Back to agents" : "Archived agents"}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="12" height="3.5" rx="1" />
          <path d="M3.5 6.5V12a1.5 1.5 0 0 0 1.5 1.5h6A1.5 1.5 0 0 0 12.5 12V6.5M6.5 9.5h3" />
        </svg>
        <span>Archive</span>
      </button>
    </div>
  );
}
