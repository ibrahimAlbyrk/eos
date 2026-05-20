import { memo, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { groupEvents, turnBlocks } from "../lib/groupEvents.js";
import { toolIcon, modelShort, stripMcpPrefix } from "../lib/format.js";
import { Icon, Avatar, CopyBtn } from "./primitives.jsx";

const ToolCard = memo(function ToolCard({ tool, result }) {
  const [open, setOpen] = useState(false);
  const hasResult = !!result;
  const isError = result?.type === "error";
  // An empty body still counts as "completed" for the status pill (so we don't
  // get stuck on "running") but there's nothing useful to render in a pane.
  const showOutput = hasResult && !!(result.body && String(result.body).trim());
  const argsPreview = (tool.args || "").replace(/\s+/g, " ").slice(0, 80);
  return (
    <div className={`vb-tool ${open ? "is-open" : ""}`}>
      <button className="vb-tool__head" onClick={() => setOpen(o => !o)}>
        <span className="vb-tool__icon"><Icon name={toolIcon(tool.tool)} size={13} /></span>
        <div className="vb-tool__head-text">
          <div className="vb-tool__head-name"><span>{stripMcpPrefix(tool.tool)}</span><Icon name={open ? "chevronDown" : "chevronRight"} size={11} /></div>
          <div className="vb-tool__head-args">{argsPreview}</div>
        </div>
        <span className="vb-tool__status">
          {hasResult
            ? (isError
                ? <span className="vb-pill" style={{ color: "var(--vb-err)", background: "var(--vb-ember-soft)", borderColor: "rgba(217,126,126,0.32)" }}><Icon name="cross" size={10} /> err</span>
                : <span className="vb-pill vb-pill--ok"><Icon name="check" size={10} /> ok</span>)
            : <span className="vb-pill vb-pill--warn"><span className="vb-spinner" /> running</span>}
        </span>
      </button>
      {open && (
        <div className="vb-tool__body" style={showOutput ? undefined : { gridTemplateColumns: "1fr" }}>
          <div className="vb-tool__pane">
            <div className="vb-tool__pane-head">
              <span>input</span>
              <CopyBtn text={tool.args || ""} />
            </div>
            <pre className="vb-code">{tool.args || "(no args)"}</pre>
          </div>
          {showOutput && (
            <div className="vb-tool__pane">
              <div className="vb-tool__pane-head">
                <span>{isError ? "error" : "output"}</span>
                <CopyBtn text={result.body || ""} />
              </div>
              <pre className="vb-code">{result.body}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const UserTurn = memo(function UserTurn({ turn }) {
  const e = turn.events[0];
  return (
    <div className="vb-turn vb-turn--user">
      <div className="vb-userbubble">
        <div className="vb-userbubble__head">
          <span className="vb-userbubble__name">You</span>
          <span className="vb-userbubble__ts">{e.ts}</span>
          <CopyBtn text={e.body} className="vb-copybtn--on-clay" />
        </div>
        <div className="vb-userbubble__body">{e.body}</div>
      </div>
    </div>
  );
});

const SystemTurn = memo(function SystemTurn({ turn, agents }) {
  const e = turn.events[0];
  const agent = agents.find(a => a.id === e.agent);
  return (
    <div className="vb-systemrow">
      <div className="vb-systemrow__dot" />
      <div className="vb-systemrow__body">
        <span className="vb-systemrow__agent">{agent?.name || e.agent}</span>
        <span> · </span>
        <span>{e.body}</span>
      </div>
      <div className="vb-systemrow__ts">{e.ts}</div>
    </div>
  );
});

const AgentTurn = memo(function AgentTurn({ turn, agents }) {
  const agent = agents.find(a => a.id === turn.agent);
  if (!agent) return null;
  const blocks = useMemo(() => turnBlocks(turn), [turn]);
  const last = turn.events[turn.events.length - 1];
  return (
    <div className={`vb-turn vb-turn--agent vb-turn--${agent.role}`}>
      <div className="vb-turn__rail">
        <Avatar agent={agent} size={32} />
        <div className="vb-turn__line" />
      </div>
      <div className="vb-turn__body">
        <div className="vb-turn__head">
          <span className={`vb-turn__name vb-turn__name--${agent.role}`}>{agent.name}</span>
          <span className="vb-turn__model vb-mono">{modelShort(agent.model)}</span>
          <span className="vb-turn__ts vb-mono">{last.ts}</span>
        </div>
        <div className="vb-turn__content">
          {blocks.map((b, i) => {
            if (b.kind === "thought") {
              return (
                <div key={i} className="vb-textblock is-thought">
                  <div className="vb-textblock__label">
                    <Icon name="thinking" size={11} />
                    <span>thinking</span>
                    <CopyBtn text={b.e.body} className="vb-textblock__copy" />
                  </div>
                  <div className="vb-textblock__body">{b.e.body}</div>
                </div>
              );
            }
            if (b.kind === "toolpair") return <ToolCard key={i} tool={b.tool} result={b.result} />;
            if (b.kind === "tool") return <ToolCard key={i} tool={b.tool} />;
            if (b.kind === "result") {
              const body = (b.result.body || "").trim();
              if (!body) return null; // skip empty orphan results
              const isError = b.result.type === "error";
              return (
                <div key={i} className="vb-tool">
                  <div className="vb-tool__body" style={{ gridTemplateColumns: "1fr", borderTop: "none" }}>
                    <div className="vb-tool__pane">
                      <div className="vb-tool__pane-head">{isError ? "error" : "result"}</div>
                      <pre className="vb-code">{body}</pre>
                    </div>
                  </div>
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
});

// Visible window into the global event list. Phase D adds incremental
// expansion via `visibleCount` to keep the DOM small even with 300+ events.
export const ActivityFeed = memo(function ActivityFeed({ events, agents, scope, busy, visibleCount, onLoadEarlier }) {
  const sliced = useMemo(() => {
    if (!visibleCount || events.length <= visibleCount) return events;
    return events.slice(-visibleCount);
  }, [events, visibleCount]);
  const turns = useMemo(() => groupEvents(sliced), [sliced]);
  const ref = useRef(null);
  // Auto-scroll only when already pinned to bottom — preserves manual
  // scrollback while the user is reading older events.
  const stickRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns.length]);
  const onScroll = useCallback(() => {
    const el = ref.current; if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);
  const hidden = visibleCount ? Math.max(0, events.length - visibleCount) : 0;
  return (
    <div className="vb-feed" ref={ref} onScroll={onScroll}>
      <div className="vb-feed__inner">
        <div className="vb-feed__intro">
          <div className="vb-feed__intro-eyebrow">Session activity</div>
          <div className="vb-feed__intro-title">{scope}</div>
        </div>
        {hidden > 0 && onLoadEarlier && (
          <button className="vb-btn vb-btn--ghost" style={{ alignSelf: "center", margin: "4px 0 12px" }} onClick={onLoadEarlier}>
            <Icon name="history" size={12} /> <span>Load earlier ({hidden})</span>
          </button>
        )}
        {turns.length === 0 && !busy && (
          <div className="vb-empty" style={{ padding: "40px 0" }}>
            <Icon name="sparkle" size={28} />
            <div>No activity yet — send a message to begin.</div>
          </div>
        )}
        {turns.map((t, i) => {
          if (t.kind === "user") return <UserTurn key={i} turn={t} />;
          if (t.kind === "system") return <SystemTurn key={i} turn={t} agents={agents} />;
          return <AgentTurn key={i} turn={t} agents={agents} />;
        })}
        {busy && (
          <div className="vb-feed__thinking">
            <div className="vb-thinking-bar">
              <div className="vb-thinking-bar__fill" />
            </div>
            <span>{scope} is thinking…</span>
          </div>
        )}
      </div>
    </div>
  );
});

export const ConsolePane = memo(function ConsolePane({ events, agents }) {
  return (
    <div className="vb-feed vb-feed--console">
      <div className="vb-feed__inner">
        {events.length === 0 && <div className="vb-empty" style={{ padding: "40px 0" }}><div>No console output yet.</div></div>}
        {events.map(e => {
          const agent = agents.find(a => a.id === e.agent);
          return (
            <div key={e.id} className="vb-console-line">
              <span className="vb-mono vb-console-line__ts">{e.ts}</span>
              <span className="vb-console-line__agent">{agent?.name || e.agent}</span>
              <span className={`vb-console-line__type vb-console-line__type--${e.type}`}>{e.type}</span>
              <span className="vb-mono vb-console-line__body">{(e.body || e.args || "").slice(0, 200)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
