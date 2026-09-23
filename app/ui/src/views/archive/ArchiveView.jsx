import { useEffect, useMemo, useSyncExternalStore } from "react";
import { TranscriptHost } from "../code/messages/TranscriptHost.jsx";
import { Composer } from "../code/center/Composer.jsx";
import { breadcrumbFor } from "../../lib/breadcrumb.js";
import { nameOf } from "../../lib/agentName.js";
import { fmtTimeAgo } from "../../lib/format.js";
import { subscribe, getArchive, refreshArchived } from "../../state/archiveStore.js";

// The archive title bar: same .pane-head strip the live single pane uses (32px
// inset, native drag strip, bottom rule). Shows the archived agent's name + a
// "project · archived Nd ago" meta, or just "Archive" for the empty / nothing-
// selected states.
function ArchiveHead({ name, meta }) {
  return (
    <div className="pane-head pane-head--topleft">
      <span className="pane-head-inset" aria-hidden="true" />
      <div className="crumb">
        <span className="cur">{name}</span>
        {meta && <span className="scope">{meta}</span>}
      </div>
    </div>
  );
}

// The app's archive tray glyph, matching the sidebar Archive row + nav icon.
function TrayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="3.5" rx="1" />
      <path d="M3.5 6.5V12a1.5 1.5 0 0 0 1.5 1.5h6A1.5 1.5 0 0 0 12.5 12V6.5M6.5 9.5h3" />
    </svg>
  );
}

// Archive panel — fills the CodeView main area while archive mode is on. The
// selected archived root gets the SAME single-pane view a live agent gets
// (title bar + TranscriptHost + per-pane Composer). Those components resolve the
// worker row and its subtree from `live.workers`, which excludes archived rows —
// so a shim `{ ...live, workers: rows }` feeds them the archived subtree instead;
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
    const isEmpty = loaded && rows.length === 0;
    return (
      <div className="single-pane">
        <div className="sp-main">
          <ArchiveHead name="Archive" />
          <div className="empty-state">
            <span className="empty-state__icon">
              <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="12" height="4" rx="1" />
                <path d="M3.5 7v5.5h9V7M6.5 9.5h3" />
              </svg>
            </span>
            <span className="empty-state__title">{isEmpty ? "Archive is empty" : "Select an archived agent"}</span>
            {isEmpty && <span className="empty-state__subtitle">⌘W archives an agent instead of deleting it.</span>}
          </div>
        </div>
      </div>
    );
  }

  const { project } = breadcrumbFor(rows, selected.id);
  const meta = `${project} · archived ${selected.archived_at ? fmtTimeAgo(selected.archived_at) : "just now"}`;

  return (
    <div className="single-pane">
      <div className="sp-main">
        <ArchiveHead name={nameOf(selected)} meta={meta} />
        <div className="pane-tx">
          <TranscriptHost live={archLive} activeId={selected.id} />
        </div>
        <div className="archive-hint">
          <span className="archive-hint__icon" aria-hidden="true"><TrayIcon /></span>
          Archived — restore to interact
        </div>
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
