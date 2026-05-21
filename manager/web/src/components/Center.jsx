import { memo, useState, useCallback } from "react";
import { CONFIG } from "../config.js";
import { Icon } from "./primitives.jsx";
import { PendingBanner, PendingPane } from "./Pending.jsx";
import { ActivityFeed, ConsolePane } from "./Feed.jsx";
import { Composer } from "./Composer.jsx";

const FEED_PAGE = 50;

export const Center = memo(function Center({ events, agents, selected, pending, onApprove, onDeny, onSend }) {
  const [tab, setTab] = useState("activity");
  const [visibleCount, setVisibleCount] = useState(FEED_PAGE);
  const scope = selected ? selected.name : "all agents";
  const busy = !!(selected && (selected.status === "thinking" || selected.status === "running"));
  // `starting` covers the SPAWNING→WORKING window: the PTY child exists but
  // hasn't reported its first signal yet. We surface it as a distinct empty
  // state so the feed never contradicts the Composer ("starting up…" vs
  // "send a message to begin").
  const starting = !!(selected && selected.status === "queued");
  // Composer goes dim when there is no agent, when the chosen one hasn't
  // booted yet (queued, before claude PTY is up), or when it's terminal.
  let disabled = false;
  let disabledReason = null;
  if (!selected) { disabled = true; disabledReason = "Select an agent to start a conversation"; }
  else if (selected.status === "queued") { disabled = true; disabledReason = `${selected.name} is starting up…`; }
  else if (selected.status === "done" || selected.status === "killed" || selected.status === "error") {
    disabled = true; disabledReason = `${selected.name} has ${selected.status === "killed" ? "been killed" : selected.status === "error" ? "errored" : "finished"} — spawn a new one`;
  }
  const onLoadEarlier = useCallback(() => {
    setVisibleCount(c => Math.min(c + FEED_PAGE, CONFIG.maxEventHistory));
  }, []);
  return (
    <main className="vb-main">
      <div className="vb-main__head">
        <div className="vb-segctrl" role="tablist" aria-label="Center pane">
          <button
            className={`vb-seg ${tab === "activity" ? "is-active" : ""}`}
            onClick={() => setTab("activity")}
            role="tab"
            aria-selected={tab === "activity"}
            aria-controls="center-panel-activity"
          >
            <Icon name="list" size={12} /> Activity
            <span className="vb-seg__badge">{events.length}</span>
          </button>
          <button
            className={`vb-seg ${tab === "pending" ? "is-active" : ""}`}
            onClick={() => setTab("pending")}
            role="tab"
            aria-selected={tab === "pending"}
            aria-controls="center-panel-pending"
          >
            <Icon name="shield" size={12} /> Pending
            {pending.length > 0 && <span className="vb-seg__badge vb-seg__badge--alert">{pending.length}</span>}
          </button>
          <button
            className={`vb-seg ${tab === "console" ? "is-active" : ""}`}
            onClick={() => setTab("console")}
            role="tab"
            aria-selected={tab === "console"}
            aria-controls="center-panel-console"
          >
            <Icon name="terminal" size={12} /> Console
          </button>
        </div>
      </div>

      <PendingBanner pending={pending} agents={agents} onApprove={onApprove} onDeny={onDeny} />

      {tab === "activity" && (
        <ActivityFeed
          events={events}
          agents={agents}
          scope={scope}
          busy={busy}
          starting={starting}
          visibleCount={visibleCount}
          onLoadEarlier={onLoadEarlier}
        />
      )}
      {tab === "pending" && <PendingPane pending={pending} agents={agents} onApprove={onApprove} onDeny={onDeny} />}
      {tab === "console" && <ConsolePane events={events} agents={agents} />}

      <Composer target={selected?.name || "Orchestrator"} busy={busy} onSend={onSend} model={selected?.model} disabled={disabled} disabledReason={disabledReason} />
    </main>
  );
});
