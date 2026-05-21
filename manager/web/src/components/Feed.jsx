import { memo, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { groupEvents, turnBlocks } from "../lib/groupEvents.js";
import { toolIcon, modelShort, stripMcpPrefix } from "../lib/format.js";
import { renderMarkdown } from "../lib/markdown.js";
import { Icon, Avatar, CopyBtn } from "./primitives.jsx";

// Memoized markdown render for prose blocks. Each block has a stable id so
// the same parsed HTML survives across re-renders without re-parsing.
const Markdown = memo(function Markdown({ source, className = "" }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={`vb-md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
});

const ToolCard = memo(function ToolCard({ tool, result }) {
  const [open, setOpen] = useState(false);
  const hasResult = !!result;
  const isError = result?.type === "error";
  // An empty body still counts as "completed" for the status pill (so we don't
  // get stuck on "running") but there's nothing useful to render in a pane.
  const showOutput = hasResult && !!(result.body && String(result.body).trim());
  // Whitespace-collapsed for the single-line header; CSS ellipsis handles the
  // visual cut — the full args panel is one click away when the card expands.
  const argsPreview = (tool.args || "").replace(/\s+/g, " ");
  return (
    <div className={`vb-tool ${open ? "is-open" : ""}`}>
      <button className="vb-tool__head" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${stripMcpPrefix(tool.tool)} tool details`}>
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
            // Stable keys derived from the underlying event id so reorders
            // (or future incremental inserts) don't mis-identify nodes.
            if (b.kind === "thought") {
              const key = b.e.id || `t-${i}`;
              return (
                <div key={key} className="vb-textblock is-thought">
                  <div className="vb-textblock__label">
                    <Icon name="thinking" size={11} />
                    <span>thinking</span>
                    <CopyBtn text={b.e.body} className="vb-textblock__copy" />
                  </div>
                  <Markdown source={b.e.body} />
                </div>
              );
            }
            if (b.kind === "text") {
              // Regular assistant response — no badge, just the prose. Copy
              // affordance hovers in the corner so users can still grab the
              // raw text without selecting around markdown.
              const key = b.e.id || `x-${i}`;
              return (
                <div key={key} className="vb-textblock is-response">
                  <Markdown source={b.e.body} />
                  <CopyBtn text={b.e.body} className="vb-textblock__copy vb-textblock__copy--floating" />
                </div>
              );
            }
            if (b.kind === "toolpair") {
              const key = b.tool.id || `tp-${i}`;
              return <ToolCard key={key} tool={b.tool} result={b.result} />;
            }
            if (b.kind === "tool") {
              const key = b.tool.id || `to-${i}`;
              return <ToolCard key={key} tool={b.tool} />;
            }
            if (b.kind === "result") {
              const body = (b.result.body || "").trim();
              if (!body) return null; // skip empty orphan results
              const isError = b.result.type === "error";
              const key = b.result.id || `r-${i}`;
              return (
                <div key={key} className="vb-tool">
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
export const ActivityFeed = memo(function ActivityFeed({ events, agents, scope, scopeKey, busy, starting, visibleCount, onLoadEarlier }) {
  const sliced = useMemo(() => {
    if (!visibleCount || events.length <= visibleCount) return events;
    return events.slice(-visibleCount);
  }, [events, visibleCount]);
  const turns = useMemo(() => groupEvents(sliced), [sliced]);
  const ref = useRef(null);
  // Auto-scroll only when already pinned to bottom — preserves manual
  // scrollback while the user is reading older events.
  const stickRef = useRef(true);
  // Per-scope scroll memory. Without this, switching agents leaves the
  // scroll at whatever the previous agent had (which is meaningless for
  // the new event list) and the turns.length effect snaps it to bottom.
  const memRef = useRef(new Map());
  const prevScopeRef = useRef(null);
  const key = scopeKey ?? scope;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = prevScopeRef.current;
    if (prev !== null && prev !== key) {
      memRef.current.set(prev, { top: el.scrollTop, stick: stickRef.current });
    }
    if (prev !== key) {
      const saved = memRef.current.get(key);
      if (saved) {
        stickRef.current = saved.stick;
        el.scrollTop = saved.top;
      } else {
        stickRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
      prevScopeRef.current = key;
    }
  }, [key]);
  useLayoutEffect(() => {
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
        {turns.length === 0 && !busy && starting && (
          <div className="vb-empty vb-empty--starting" style={{ padding: "40px 0" }} role="status" aria-live="polite">
            <span className="vb-starting-spinner" aria-hidden="true" />
            <div>{scope} is starting up…</div>
            <div className="vb-empty__sub">claude PTY is booting · first signal usually arrives in ~2s</div>
          </div>
        )}
        {turns.length === 0 && !busy && !starting && (
          <div className="vb-empty" style={{ padding: "40px 0" }}>
            <Icon name="sparkle" size={28} />
            <div>No activity yet — send a message to begin.</div>
          </div>
        )}
        {turns.map((t, i) => {
          // Each turn carries at least one event; its id is stable across polls
          // because data.jsx mints ids as `${workerId}-${e.id}`. Falls back to
          // index when an event is somehow missing an id.
          const key = t.events?.[0]?.id || `turn-${i}`;
          if (t.kind === "user") return <UserTurn key={key} turn={t} />;
          if (t.kind === "system") return <SystemTurn key={key} turn={t} agents={agents} />;
          return <AgentTurn key={key} turn={t} agents={agents} />;
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
    <div className="vb-feed vb-feed--console" role="log" aria-label="Console output" aria-live="polite">
      <ol className="vb-feed__inner" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {events.length === 0 && <li className="vb-empty" style={{ padding: "40px 0" }}><div>No console output yet.</div></li>}
        {events.map(e => {
          const agent = agents.find(a => a.id === e.agent);
          return (
            <li key={e.id} className="vb-console-line">
              <span className="vb-mono vb-console-line__ts">{e.ts}</span>
              <span className="vb-console-line__agent">{agent?.name || e.agent}</span>
              <span className={`vb-console-line__type vb-console-line__type--${e.type}`}>{e.type}</span>
              <span className="vb-mono vb-console-line__body">{e.body || e.args || ""}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
});
