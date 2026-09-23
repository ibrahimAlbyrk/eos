import { useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { MODELS, modelName, effortChoicesFor } from "../../../lib/models.js";

// The combined Model & Effort popover (charcoal-aurora "rail" variant): one
// panel, opened from a single composer trigger, that replaces the separate
// ModelPopover + EffortPopover. A draggable accent rail sets the effort level
// (snaps to one of 5 stops on release); clicking the centered readout reveals an
// inline model list. Ultracode is intentionally excluded from this rail.

const RAIL_ORDER = ["low", "medium", "high", "xhigh", "max"];
const RAIL_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" };

// blue (250°) → violet (305°) by level: [fill, particle, label]
const LV = [
  ["oklch(0.42 0.09 250)", "oklch(0.93 0.04 250)", "oklch(0.74 0.10 250)"],
  ["oklch(0.45 0.12 258)", "oklch(0.93 0.05 258)", "oklch(0.75 0.12 258)"],
  ["oklch(0.48 0.14 268)", "oklch(0.93 0.05 268)", "oklch(0.75 0.13 268)"],
  ["oklch(0.49 0.15 282)", "oklch(0.93 0.05 282)", "oklch(0.75 0.14 282)"],
  ["oklch(0.50 0.16 296)", "oklch(0.97 0.04 300)", "oklch(0.78 0.15 305)"],
];
const MAX_GRADIENT =
  "linear-gradient(90deg, oklch(0.44 0.15 262), oklch(0.62 0.18 300) 60%, oklch(0.55 0.17 290))";
const DENS = [0.2, 0.38, 0.58, 0.78, 1];
const INSET = 16;
const at = (p) => `calc(${INSET}px + ${p} * (100% - ${2 * INSET}px))`;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Deterministic per-panel hash (stable across renders so particles don't jump).
const frac = (x) => x - Math.floor(x);
const R = (seed, k) => frac(Math.sin(seed * 91.7 + k * 12.9898) * 43758.5453);

function buildParticles(count, seed, color) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const sz = 1.2 + R(seed, i * 4) ** 2 * 1.6;
    const top = 12 + R(seed, i * 4 + 1) * 76;
    const rate = 0.5 + R(seed, i * 4 + 2) * 1.2;
    const dur = 7 / rate;
    const tw = 1.4 + R(seed, i * 5) * 2.2;
    out.push({
      key: i,
      top,
      dur,
      driftDelay: -R(seed, i * 9) * dur,
      twinkle: tw,
      twDelay: -R(seed, i * 11) * tw,
      scale: sz / 8,
      color,
    });
  }
  return out;
}

export function ModelEffortPanel({ live, worker, config, onPick }) {
  const ui = useUi();
  if (ui.openPopover !== "effort") return null;
  return <RailPanel live={live} ui={ui} worker={worker} config={config} onPick={onPick} />;
}

function RailPanel({ live, ui, worker, config, onPick }) {
  const paneRef = useRef(null);
  const barRef = useRef(null);
  const particleWrapRef = useRef(null);
  const [dragFrac, setDragFrac] = useState(null); // non-null while dragging
  const [showList, setShowList] = useState(false);

  const selected = worker ?? null;
  const currentModel = selected?.model ?? config?.model ?? ui.composer.model;
  const currentEffort = selected?.effort ?? config?.effort ?? ui.composer.effort;

  // The rail's ordered stops = the API effort levels the model supports, minus
  // ultracode. A model that supports no effort hides the whole panel upstream.
  const levels = useMemo(() => {
    const ids = new Set(effortChoicesFor(currentModel).map((e) => e.id));
    return RAIL_ORDER.filter((id) => ids.has(id));
  }, [currentModel]);
  const count = levels.length || RAIL_ORDER.length;
  const railIds = levels.length ? levels : RAIL_ORDER;

  useEffect(() => { paneRef.current?.focus(); }, []);

  const fracFromIdx = (i) => (count > 1 ? i / (count - 1) : 0);
  const idxFromFrac = (f) => (count > 1 ? Math.round(clamp01(f) * (count - 1)) : 0);
  const colorIdxOf = (i) => (count > 1 ? Math.round((i / (count - 1)) * 4) : 0);

  let committedIdx = railIds.indexOf(currentEffort);
  if (committedIdx < 0) committedIdx = currentEffort === "ultracode" ? count - 1 : Math.min(count - 1, idxFromFrac(0.5));
  const dragging = dragFrac !== null;
  const shownFrac = dragging ? dragFrac : fracFromIdx(committedIdx);
  const shownIdx = dragging ? idxFromFrac(dragFrac) : committedIdx;
  const colorIdx = colorIdxOf(shownIdx);
  const isMax = shownIdx === count - 1;
  const lvl = LV[colorIdx];

  const commit = (i) => {
    const id = railIds[i];
    if (!id || id === currentEffort) return;
    if (selected) live.setModel(selected.id, currentModel, id);
    else if (onPick) onPick(id);
    else ui.updateComposer({ effort: id });
  };

  const pickModel = (m) => {
    const id = m.aliases?.[0] ?? m.id;
    if (selected) live.setModel(selected.id, id, currentEffort);
    else if (onPick) onPick(id);
    else ui.updateComposer({ model: id });
    setShowList(false);
  };

  const reset = () => {
    setDragFrac(null);
    const mid = railIds.indexOf("medium");
    commit(mid >= 0 ? mid : Math.floor((count - 1) / 2));
  };

  const fracAt = (clientX) => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clamp01((clientX - r.left - INSET) / (r.width - 2 * INSET));
  };
  const onPointerDown = (e) => {
    if (e.button) return;
    e.preventDefault();
    setDragFrac(fracAt(e.clientX));
    const move = (ev) => setDragFrac(fracAt(ev.clientX));
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const i = idxFromFrac(fracAt(ev.clientX));
      setDragFrac(null);
      commit(i);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowLeft" && shownIdx > 0) commit(shownIdx - 1);
    else if (e.key === "ArrowRight" && shownIdx < count - 1) commit(shownIdx + 1);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  // Particle field: regenerated only when the level (count) changes; drift speed
  // scales in real time via playbackRate so a higher level = faster + denser.
  const spd = 0.55 + colorIdx * 0.7;
  const particles = useMemo(
    () => buildParticles(Math.round(26 * DENS[colorIdx]), 1, lvl[1]),
    [colorIdx, lvl[1]],
  );
  useEffect(() => {
    const wrap = particleWrapRef.current;
    if (!wrap) return;
    for (const el of wrap.querySelectorAll("[data-effp]")) {
      for (const a of el.getAnimations?.() ?? []) {
        if (a.playbackRate !== spd) a.playbackRate = spd;
      }
    }
  }, [spd, particles]);

  // Model supports no effort levels → nothing to show. Placed AFTER every hook so
  // the hook order is identical on every render (react-hooks/rules-of-hooks).
  if (!levels.length) return null;

  const noAnim = dragging;
  const fillW = `calc(${2 * INSET}px + ${shownFrac} * (100% - ${2 * INSET}px))`;
  const clip = `inset(0 calc(100% - (${2 * INSET}px + ${shownFrac} * (100% - ${2 * INSET}px))) 0 0 round 999px)`;

  return (
    <div
      className="me-panel"
      data-popover="effort"
      ref={paneRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {showList ? (
        <div className="me-models">
          {MODELS.map((m, i) => {
            const on = currentModel === m.id || m.aliases?.includes(currentModel);
            return (
              <button key={m.id} className={"me-model-row" + (on ? " on" : "")} onClick={() => pickModel(m)}>
                <span className="me-model-name">{m.name}</span>
                {on && (
                  <svg className="me-model-check" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m2.5 8.5 3.5 3.5 7.5-8" />
                  </svg>
                )}
                <span className="me-model-num">{i + 1}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="me-effort">
          <div className="me-head">
            <span className="me-head-spacer" />
            <div className="me-readout" onClick={() => setShowList(true)}>
              <span className="me-level" style={{ color: lvl[2] }}>
                <span className="me-level-name">{RAIL_LABELS[railIds[shownIdx]] ?? railIds[shownIdx]}</span>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
                  <path d="m6 3.5 4.5 4.5L6 12.5" />
                </svg>
              </span>
              <span className="me-model-cur">{modelName(currentModel) || currentModel}</span>
            </div>
            <button className="me-reset" onClick={reset} title="Reset to Medium" aria-label="Reset effort">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
                <path d="M3.5 3.5v5h5" />
              </svg>
            </button>
          </div>

          <div className="me-bar" ref={barRef} onPointerDown={onPointerDown}>
            <div
              className="me-fill"
              style={{
                width: fillW,
                backgroundColor: lvl[0],
                transition: noAnim ? "background-color .35s" : "width .22s cubic-bezier(.3,.7,.2,1), background-color .35s",
              }}
            >
              <span className="me-fill-max" style={{ background: MAX_GRADIENT, opacity: isMax ? 1 : 0 }} />
            </div>
            <div
              className="me-particles"
              ref={particleWrapRef}
              style={{ clipPath: clip, WebkitClipPath: clip, transition: noAnim ? "none" : "clip-path .22s cubic-bezier(.3,.7,.2,1)" }}
            >
              {particles.map((p) => (
                <span
                  key={p.key}
                  data-effp="1"
                  className="me-p-drift"
                  style={{ top: `${p.top}%`, animationDuration: `${p.dur.toFixed(2)}s`, animationDelay: `${p.driftDelay.toFixed(2)}s` }}
                >
                  <span
                    className="me-p-dot"
                    style={{
                      background: p.color,
                      transform: `scale(${p.scale.toFixed(3)})`,
                      animationDuration: `${p.twinkle.toFixed(2)}s`,
                      animationDelay: `${p.twDelay.toFixed(2)}s`,
                    }}
                  />
                </span>
              ))}
            </div>
            {railIds.map((id, i) => {
              const p = fracFromIdx(i);
              return (
                <span
                  key={id}
                  className="me-tick"
                  style={{ left: at(p), background: p <= shownFrac + 0.001 ? "rgba(11,16,24,0.35)" : "rgba(255,255,255,0.22)" }}
                />
              );
            })}
            <span
              className="me-thumb"
              style={{ left: at(shownFrac), transition: noAnim ? "none" : "left .22s cubic-bezier(.3,.7,.2,1)" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
