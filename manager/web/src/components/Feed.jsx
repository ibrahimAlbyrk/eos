import { memo, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { groupEvents, turnBlocks } from "../lib/groupEvents.js";
import { modelShort } from "../lib/format.js";
import { renderMarkdown, onLanguageReady } from "../lib/markdown.js";
import { Icon, Avatar, CopyBtn } from "./primitives.jsx";
import { ToolBlock, OrphanResult } from "./tools/ToolBlock.jsx";

// Subscribes to hljs language-pack load events. Bumps a counter so memoized
// markdown renders refresh once a lazy-loaded grammar becomes available.
function useLanguageReadyVersion() {
  const [v, setV] = useState(0);
  useEffect(() => onLanguageReady(() => setV((x) => x + 1)), []);
  return v;
}

// Memoized markdown render for prose blocks. Each block has a stable id so
// the same parsed HTML survives across re-renders without re-parsing.
const Markdown = memo(function Markdown({ source, className = "" }) {
  const langVer = useLanguageReadyVersion();
  const html = useMemo(() => renderMarkdown(source), [source, langVer]);
  return <div className={`vb-md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
});

// Module-scope set of block keys we've already revealed. Survives unmount
// (e.g., when the user scrolls a block out of view or switches tabs) so we
// never replay the typewriter for the same content twice. Bounded so long
// sessions don't leak memory — oldest entries drop once we exceed the cap.
const REVEALED_CAP = 2000;
const revealedBlocks = new Set();
function markRevealed(key) {
  if (revealedBlocks.has(key)) return;
  if (revealedBlocks.size >= REVEALED_CAP) {
    const first = revealedBlocks.values().next().value;
    if (first !== undefined) revealedBlocks.delete(first);
  }
  revealedBlocks.add(key);
}

// Wall-clock at page load. Anything with an event ts older than this is
// "historical" — already happened before the user opened the page, so we
// render it instantly instead of typewriter-replaying the whole transcript.
const PAGE_LOAD_TS = Date.now();

// Progressive character reveal driven by rAF. When `skip` is true the hook
// resolves to fully-revealed without animating (used for historical events
// and remounted-but-already-seen blocks).
function useTypewriter(text, key, { cps = 320, skip = false } = {}) {
  const total = text ? text.length : 0;
  const alreadyDone = skip || revealedBlocks.has(key);
  const [chars, setChars] = useState(() => (alreadyDone ? total : 0));
  useEffect(() => {
    if (alreadyDone) { setChars(total); markRevealed(key); return; }
    if (total === 0) { markRevealed(key); return; }
    let raf = 0;
    let start = 0;
    const duration = Math.min(4500, Math.max(350, (total / cps) * 1000));
    const tick = (t) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / duration);
      // ease-out cubic — fast settle so the last few chars don't lag.
      const eased = 1 - Math.pow(1 - p, 3);
      setChars(Math.max(1, Math.floor(eased * total)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else markRevealed(key);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [key, total, cps, alreadyDone]);
  return { chars, done: alreadyDone || chars >= total };
}

// Markdown block that types itself in on first appearance. Subsequent
// renders (after scroll/remount) show the full text immediately.
const AnimatedMarkdown = memo(function AnimatedMarkdown({ source, blockKey, eventTs, className = "" }) {
  const isHistorical = eventTs != null && eventTs < PAGE_LOAD_TS;
  const { chars, done } = useTypewriter(source || "", blockKey, { skip: isHistorical });
  const sliced = useMemo(() => (source || "").slice(0, chars), [source, chars]);
  const langVer = useLanguageReadyVersion();
  const html = useMemo(() => renderMarkdown(sliced), [sliced, langVer]);
  return (
    <div
      className={`vb-md ${className} ${done ? "" : "is-typing"}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
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
        <Markdown source={e.body} className="vb-userbubble__body" />
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
                  <AnimatedMarkdown source={b.e.body} blockKey={key} eventTs={b.e._ts} />
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
                  <AnimatedMarkdown source={b.e.body} blockKey={key} eventTs={b.e._ts} />
                  <CopyBtn text={b.e.body} className="vb-textblock__copy vb-textblock__copy--floating" />
                </div>
              );
            }
            if (b.kind === "toolpair") {
              const key = b.tool.id || `tp-${i}`;
              return <ToolBlock key={key} tool={b.tool} result={b.result} />;
            }
            if (b.kind === "tool") {
              const key = b.tool.id || `to-${i}`;
              return <ToolBlock key={key} tool={b.tool} />;
            }
            if (b.kind === "result") {
              const body = (b.result.body || "").trim();
              if (!body) return null;
              const key = b.result.id || `r-${i}`;
              return <OrphanResult key={key} result={b.result} />;
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
export const ActivityFeed = memo(function ActivityFeed({ events, agents, scope, scopeKey, busy, busyKind = "thinking", starting, visibleCount, onLoadEarlier }) {
  const sliced = useMemo(() => {
    if (!visibleCount || events.length <= visibleCount) return events;
    return events.slice(-visibleCount);
  }, [events, visibleCount]);
  const turns = useMemo(() => groupEvents(sliced), [sliced]);
  // Decide whether the bottom-of-feed skeleton (or "is working" bar) is
  // appropriate. We want the thought-forming skeleton whenever the agent is
  // mid-turn but NOT currently waiting on a tool — tool execution is already
  // signaled by the tool card's spinner, so doubling up reads as noise.
  const showThoughtSkeleton = useMemo(() => {
    if (!busy) return false;
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn || lastTurn.kind !== "agent") return true;
    const blocks = turnBlocks(lastTurn);
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock) return true;
    // An unpaired tool means the tool is still running — let its card own
    // the loading affordance.
    return lastBlock.kind !== "tool";
  }, [busy, turns]);
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
  // Stick to bottom while content grows mid-block (typewriter reveal, async
  // markdown loading, etc.) — without this, growing blocks visibly push the
  // user's view up even though they were pinned to the latest output.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const inner = el.querySelector(".vb-feed__inner");
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);
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
        {showThoughtSkeleton && (
          <div className="vb-textblock is-thought vb-thought-skeleton" role="status" aria-live="polite">
            <div className="vb-textblock__label">
              <Icon name="thinking" size={11} />
              <span>thinking</span>
              <span className="vb-thought-skeleton__hint">{scope} is forming a thought…</span>
            </div>
            <div className="vb-skel-lines" aria-hidden="true">
              <span className="vb-skel-line" style={{ width: "92%" }} />
              <span className="vb-skel-line" style={{ width: "78%" }} />
              <span className="vb-skel-line" style={{ width: "54%" }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

