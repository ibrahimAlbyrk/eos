import { memo, useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { Icon } from "../icons.jsx";
import { pickPortrait } from "../lib/portraits.js";

// Re-export Icon so other components in this folder can `import { Icon } from "./primitives.jsx"`.
export { Icon };

// Process-wide cache for /fs/default-app responses. Keyed by extension when
// the path has one (the daemon caches the same way), else by full path.
// Values are Promises so concurrent button mounts share a single in-flight
// request. Persists for the page lifetime — restart to pick up changes if
// you re-associate default apps in macOS settings.
const _defaultAppCache = new Map();

function _cacheKey(path) {
  const dot = path.lastIndexOf(".");
  if (dot > path.lastIndexOf("/") && dot < path.length - 1) {
    return `ext:${path.slice(dot + 1).toLowerCase()}`;
  }
  return `path:${path}`;
}

function _lookupDefaultApp(path) {
  const key = _cacheKey(path);
  const hit = _defaultAppCache.get(key);
  if (hit) return hit;
  const promise = fetch(`/fs/default-app?path=${encodeURIComponent(path)}`)
    .then((r) => r.ok ? r.json() : { app: null })
    .then((data) => data?.app ?? null)
    .catch(() => null);
  _defaultAppCache.set(key, promise);
  return promise;
}

// Text-style chip for "open this file in its default OS app". Resolves the
// app lazily on mount (cheap — backend caches per extension), renders
// nothing while loading or when no default app is found.
export const FileOpenButton = memo(function FileOpenButton({ path, className = "" }) {
  const [app, setApp] = useState(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let cancelled = false;
    _lookupDefaultApp(path).then((info) => { if (!cancelled) setApp(info); });
    return () => { cancelled = true; };
  }, [path]);
  const onClick = useCallback(async (e) => {
    e.stopPropagation();
    if (opening) return;
    setOpening(true);
    try {
      await fetch("/fs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
    } catch {}
    setTimeout(() => setOpening(false), 400);
  }, [path, opening]);
  if (!app || !app.appName) return null;
  const label = `Open with ${app.appName}`;
  return (
    <button
      className={`vb-fileopen ${opening ? "is-opening" : ""} ${className}`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {label}
    </button>
  );
});

// Drives an expand/collapse affordance for a long <pre> code block. Returns
// a ref to attach to the <pre>, the current expanded state, an `overflowing`
// flag that's true only when content exceeds the CSS max-height, and a
// toggle. The toggle is meant to live in the surrounding pane head next to
// the copy button — see ExpandToggle for the rendered button.
//
// `deps` should include anything that can change the rendered length (the
// text itself, sibling pane visibility, theme, etc.) so the overflow probe
// re-runs after layout settles.
export function useExpandableCode(...deps) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only measure while collapsed: once expanded, max-height is removed so
    // scrollHeight == clientHeight and the probe would falsely report "no
    // overflow", which would hide the collapse button.
    if (expanded) return;
    // +1 absorbs sub-pixel rounding; without it tall-but-not-overflowing
    // panes flicker the button on/off as the viewport breathes.
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, ...deps]);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  return { ref, expanded, overflowing, toggle };
}

// Pane-head chip rendered when a code block is either currently expanded or
// long enough to need expanding. Stays out of the way otherwise.
export const ExpandToggle = memo(function ExpandToggle({ expanded, overflowing, onToggle }) {
  if (!expanded && !overflowing) return null;
  return (
    <button
      className="vb-expand-btn"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={expanded ? "Collapse" : "Expand"}
      aria-expanded={expanded}
    >
      <Icon name={expanded ? "chevronUp" : "chevronDown"} size={10} />
      <span>{expanded ? "Collapse" : "Expand"}</span>
    </button>
  );
});

// Tiny clipboard button with a short "copied" feedback. Used on user bubbles,
// agent text blocks, and tool input/output panes.
export const CopyBtn = memo(function CopyBtn({ text, title = "Copy", className = "" }) {
  const [done, setDone] = useState(false);
  const click = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(text ?? ""));
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {}
  };
  return (
    <button className={`vb-copybtn ${done ? "is-done" : ""} ${className}`} onClick={click} title={done ? "Copied!" : title}>
      <Icon name={done ? "check" : "copy"} size={11} />
    </button>
  );
});

export const Avatar = memo(function Avatar({ agent, size = 28 }) {
  const initial = agent.role === "main" ? "C" : (agent.name?.[0] || "?").toUpperCase();
  const portrait = pickPortrait(agent);
  return (
    <div className={`vb-avatar vb-avatar--${agent.role}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      <span className="vb-avatar__fallback">
        {agent.role === "main" ? (
          <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="currentColor"><path d="M5 12c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7-7-3.1-7-7zm7-4.5L9 12l3 4.5L15 12z"/></svg>
        ) : initial}
      </span>
      {portrait && (
        <img className="vb-avatar__img" src={portrait.src} srcSet={portrait.srcSet} sizes={`${size}px`}
             alt="" loading="lazy" decoding="async"
             onError={(e) => { e.currentTarget.style.display = "none"; }} />
      )}
    </div>
  );
});

export const StatusBadge = memo(function StatusBadge({ status }) {
  const labels = { running: "running", thinking: "thinking", waiting: "idle", queued: "queued", done: "done", error: "error", killed: "killed" };
  return (
    <span className={`vb-statbadge vb-statbadge--${status}`}>
      <span className="vb-statbadge__dot" />
      <span>{labels[status] || status}</span>
    </span>
  );
});

export const RingAvatar = memo(function RingAvatar({ agent, ctxPct: pct, size = 34 }) {
  const initial = agent.role === "main" ? "C" : (agent.name?.[0] || "?").toUpperCase();
  const cx = size / 2;
  const cy = size / 2;
  const r = cx - 1.5;
  const portrait = pickPortrait(agent);
  return (
    <div className="vb-ring-av" style={{ width: size, height: size }}>
      <svg className="vb-ring-av__svg" viewBox={`0 0 ${size} ${size}`}>
        <circle className="vb-ring-av__track" cx={cx} cy={cy} r={r} fill="none" />
        <circle className={`vb-ring-av__fill vb-ring-av__fill--${agent.role}`}
              cx={cx} cy={cy} r={r}
              fill="none" pathLength="100"
              strokeDasharray={`${pct} 100`}
              transform={`rotate(-90 ${cx} ${cy})`} />
      </svg>
      <div className={`vb-ring-av__face vb-ring-av__face--${agent.role}`}>
        <span className="vb-ring-av__fallback">
          {agent.role === "main" ? (
            <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="currentColor">
              <path d="M5 12c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7-7-3.1-7-7zm7-4.5L9 12l3 4.5L15 12z"/>
            </svg>
          ) : initial}
        </span>
        {portrait && (
          <img className="vb-ring-av__img" src={portrait.src} srcSet={portrait.srcSet} sizes={`${size}px`}
               alt="" loading="lazy" decoding="async"
               onError={(e) => { e.currentTarget.style.display = "none"; }} />
        )}
      </div>
    </div>
  );
});

export const SpawnChip = memo(function SpawnChip({ parent }) {
  if (!parent) return null;
  const initial = parent.role === "main" ? "★" : (parent.name?.[0] || "?").toUpperCase();
  const portrait = pickPortrait(parent);
  return (
    <span className="vb-spawnchip" title={`Spawned by ${parent.name}`}>
      <span className="vb-spawnchip__arrow">↳</span>
      <span className={`vb-spawnchip__av vb-spawnchip__av--${parent.role}`}>
        <span className="vb-spawnchip__av-fallback">{initial}</span>
        {portrait && (
          <img className="vb-spawnchip__av-img" src={portrait.src} srcSet={portrait.srcSet} sizes="14px"
               alt="" loading="lazy" decoding="async"
               onError={(e) => { e.currentTarget.style.display = "none"; }} />
        )}
      </span>
      <span className="vb-spawnchip__name">{parent.name}</span>
    </span>
  );
});

export const LeftPanelHandle = memo(function LeftPanelHandle({ onExpand }) {
  return (
    <button className="vb-panelhandle vb-panelhandle--left" onClick={onExpand} title="Show agents panel" aria-label="Show agents panel">
      <Icon name="panelLeft" size={14} />
    </button>
  );
});

export const RightPanelHandle = memo(function RightPanelHandle({ onExpand }) {
  return (
    <button className="vb-panelhandle vb-panelhandle--right" onClick={onExpand} title="Show details panel" aria-label="Show details panel">
      <Icon name="panelRight" size={14} />
    </button>
  );
});
