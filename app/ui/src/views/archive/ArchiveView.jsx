import { useEffect, useMemo, useSyncExternalStore } from "react";
import { TranscriptHost } from "../code/messages/TranscriptHost.jsx";
import { Composer } from "../code/center/Composer.jsx";
import { subscribe, getArchive, refreshArchived } from "../../state/archiveStore.js";

// Archive panel — fills the CodeView main area while archive mode is on. The
// selected archived root gets the SAME single-pane view a live agent gets
// (TranscriptHost + per-pane Composer). Those components resolve the worker
// row and its subtree from `live.workers`, which excludes archived rows — so
// a shim `{ ...live, workers: rows }` feeds them the archived subtree instead;
// everything else (event fetches, SSE signal, clock) passes through unchanged.
// The composer is rendered inert + dimmed: archived agents are read-only until
// restored (restore/purge live in the sidebar row's context menu).
export function ArchiveView({ live }) {
  const { rows, loaded, selectedId } = useSyncExternalStore(subscribe, getArchive);

  // Refetch on mount (every archive-mode entry remounts this panel) and on
  // every SSE change ping — the same generic-ping semantics as the /workers
  // refetch in useLive. Archive, restore, and purge all emit a ping, so the
  // list self-heals after every mutation.
  useEffect(() => { refreshArchived(); }, [live.eventSignal.tick]);

  const archLive = useMemo(() => ({ ...live, workers: rows }), [live, rows]);
  const selected = rows.find((w) => w.id === selectedId) ?? null;

  if (!selected) {
    return (
      <div className="archive-main">
        <div className="archive-empty">
          {loaded && rows.length === 0
            ? "Archive is empty — ⌘W archives an agent instead of deleting it"
            : "Select an archived agent"}
        </div>
      </div>
    );
  }

  return (
    <div className="single-pane">
      <div className="sp-main">
        <div className="pane-tx">
          <TranscriptHost live={archLive} activeId={selected.id} />
        </div>
        <div className="archive-hint">Archived — restore to interact</div>
        {/* inert="" (React 18 string form) blocks focus + clicks on the whole
            composer subtree; focused={false} keeps it out of the global
            hotkey / pending-template funnels. */}
        <div className="composer-archived" inert="">
          <Composer live={archLive} worker={selected} focused={false} />
        </div>
      </div>
    </div>
  );
}
