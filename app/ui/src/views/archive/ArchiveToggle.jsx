import { useSyncExternalStore } from "react";
import { subscribe, getArchive, toggleArchiveMode } from "../../state/archiveStore.js";

export function ArchiveToggle() {
  const { archiveMode } = useSyncExternalStore(subscribe, getArchive);
  return (
    <button
      className={`sb-iconbtn${archiveMode ? " on" : ""}`}
      onClick={toggleArchiveMode}
      title="Archive"
      aria-label="Archive"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="12" height="3.5" rx="1" />
        <path d="M3.5 6.5V12a1.5 1.5 0 0 0 1.5 1.5h6A1.5 1.5 0 0 0 12.5 12V6.5M6.5 9.5h3" />
      </svg>
    </button>
  );
}
