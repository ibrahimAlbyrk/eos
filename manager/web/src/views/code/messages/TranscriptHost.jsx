import { useRef, useState } from "react";
import { Messages } from "./Messages.jsx";

// Keep-alive transcript multiplexer. Instead of remounting <Messages> on every
// agent switch (key={selectedId}) — which tore down the DOM, re-parsed all
// markdown, replayed entrance animations and reset the scroll to the top — we
// keep one <Messages> per recently-viewed agent mounted and toggle visibility.
// Switching back to a kept agent is then a single CSS class change: no remount,
// no re-render, scroll position and rendered block sizes preserved → instant.
//
// Per-agent isolation (the reason the old code keyed by id) is unchanged: each
// agent still gets its own keyed <Messages> instance — it just isn't destroyed
// on switch, only parked. Cross-agent carry-over stays impossible by construction.
//
// Bounded LRU: at most KEEP_ALIVE panes stay mounted; the least-recently-viewed
// unmounts (and detaches its poll). Aligned with eventsStore's cached-window cap.

const KEEP_ALIVE = 4;

const keyOf = (id) => (id == null ? "__empty__" : String(id));

export function TranscriptHost({ live, activeId }) {
  // LRU of agent ids to keep mounted, most-recent last; always includes active.
  const [aliveIds, setAliveIds] = useState([activeId]);
  const prevActive = useRef(activeId);

  // Derive the alive set DURING render (the React-sanctioned "adjust state on
  // prop change" pattern) so the active pane is mounted on the very same render
  // the selection changes — an effect would lag one frame and flash blank.
  if (prevActive.current !== activeId || !aliveIds.includes(activeId)) {
    prevActive.current = activeId;
    setAliveIds((prev) => {
      const next = [...prev.filter((id) => id !== activeId), activeId];
      return next.length > KEEP_ALIVE ? next.slice(next.length - KEEP_ALIVE) : next;
    });
  }

  return (
    <div className="tx-host">
      {aliveIds.map((id) => {
        const on = id === activeId;
        return (
          <div key={keyOf(id)} className={on ? "tx-pane on" : "tx-pane"} aria-hidden={!on}>
            <Messages live={live} agentId={id} isActive={on} />
          </div>
        );
      })}
    </div>
  );
}
