import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { effortChoicesFor } from "../../../lib/models.js";
import { fractionOf, nearestIndex, isUltracode, PAD, stopCalc, stopStyle } from "../../../lib/effortScale.js";
import { RollingLabel } from "../../../components/RollingLabel.jsx";
import { UltraGridCanvas } from "./UltraGridCanvas.jsx";

const INFO = {
  ultracode: {
    title: "Ultracode",
    body: "Ultracode is xhigh effort plus workflows. Most thorough, slowest, and heaviest on your limits.",
  },
  default: {
    title: "Effort",
    body: "Higher effort means more thorough responses, but takes longer and uses your limits faster.",
  },
};

export function EffortPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "effort") return null;
  return <EffortPanel live={live} ui={ui} />;
}

function EffortPanel({ live, ui }) {
  const paneRef = useRef(null);
  const sliderRef = useRef(null);
  // Dragging is JS-driven (no CSS transition): a rAF loop chases the pointer
  // target with exponential smoothing, so a grab far from the thumb glides
  // it over continuously — even while the pointer keeps moving — and once
  // caught up it locks to 1:1 tracking. The commit happens on release when
  // the thumb snaps to the nearest stop.
  const targetRef = useRef(0);
  const rafRef = useRef(0);
  const lockedRef = useRef(false);
  const lastTsRef = useRef(0);
  const [viewFrac, setViewFrac] = useState(null);
  const [preview, setPreview] = useState(null);
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => { paneRef.current?.focus(); }, []);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const tick = (ts) => {
    const dt = Math.min(0.05, (ts - lastTsRef.current) / 1000 || 0.016);
    lastTsRef.current = ts;
    setViewFrac((v) => {
      if (v === null) return v;
      const target = targetRef.current;
      if (lockedRef.current) return target;
      const next = v + (target - v) * (1 - Math.exp(-dt * 22));
      if (Math.abs(target - next) < 0.004) { lockedRef.current = true; return target; }
      return next;
    });
    rafRef.current = requestAnimationFrame(tick);
  };

  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const currentModel = selected?.model ?? ui.composer.model;
  const currentEffort = selected?.effort ?? ui.composer.effort;
  const levels = effortChoicesFor(currentModel);

  const found = levels.findIndex((l) => l.id === currentEffort);
  const idx = found >= 0 ? found : Math.max(0, levels.findIndex((l) => l.id === "xhigh"));
  const dragging = viewFrac !== null;
  const shownIdx = dragging ? nearestIndex(targetRef.current, levels.length) : (preview ?? idx);
  const level = levels[shownIdx];
  const ultra = !!level && isUltracode(level.id);

  // The grid canvas outlives the ultra state by the fade-out window so
  // leaving ultracode dissolves instead of popping.
  const [gridOn, setGridOn] = useState(false);
  useEffect(() => {
    if (ultra) { setGridOn(true); return; }
    if (!gridOn) return;
    const t = setTimeout(() => setGridOn(false), 320);
    return () => clearTimeout(t);
  }, [ultra, gridOn]);

  if (!levels.length) return null;

  const select = (i) => {
    setPreview(i);
    const l = levels[i];
    if (l.id === currentEffort) return;
    if (selected) live.setModel(selected.id, currentModel, l.id);
    else ui.updateComposer({ effort: l.id });
  };

  const fracAt = (e) => {
    const r = sliderRef.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left - PAD) / (r.width - 2 * PAD)));
  };
  const onPointerDown = (e) => {
    e.preventDefault();
    sliderRef.current.setPointerCapture(e.pointerId);
    targetRef.current = fracAt(e);
    lockedRef.current = false;
    lastTsRef.current = performance.now();
    setViewFrac(fractionOf(shownIdx, levels.length));
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  };
  const onPointerMove = (e) => { if (dragging) targetRef.current = fracAt(e); };
  const onPointerUp = (e) => {
    if (!dragging) return;
    cancelAnimationFrame(rafRef.current);
    setViewFrac(null);
    select(nearestIndex(fracAt(e), levels.length));
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowLeft" && shownIdx > 0) select(shownIdx - 1);
    else if (e.key === "ArrowRight" && shownIdx < levels.length - 1) select(shownIdx + 1);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const info = INFO[ultra ? "ultracode" : "default"];

  return (
    <div
      className="effort-popover open"
      data-popover="effort"
      ref={paneRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {/* Sibling card, not a child of the panel: WebKit renders a
          backdrop-filter nested inside another backdrop-filter flat. */}
      {showInfo && (
        <div className="effort-info glass-pop">
          <div className="ei-title">{info.title}</div>
          <div className="ei-body">{info.body}</div>
        </div>
      )}
      <div className="effort-panel glass-pop">
        <div className="ep-head">
          <span className="ep-title">Effort</span>
          <RollingLabel className={"ep-value" + (ultra ? " ultra" : "")} text={level.label} index={shownIdx} />
          <button
            className="ep-info-btn"
            aria-label="About effort"
            onMouseEnter={() => setShowInfo(true)}
            onMouseLeave={() => setShowInfo(false)}
            onClick={(e) => { e.stopPropagation(); setShowInfo((v) => !v); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="8" cy="8" r="6.2" />
              <path d="M6.3 6.4c.2-1 1-1.6 1.9-1.6 1 0 1.8.7 1.8 1.6 0 1.3-1.7 1.4-1.7 2.6" strokeLinecap="round" />
              <circle cx="8.2" cy="11.4" r="0.5" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
        <div className="ep-scale"><span>Faster</span><span>Smarter</span></div>
        <div
          className={"ep-slider" + (dragging ? " drag dragging" : "")}
          ref={sliderRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className={"ep-track" + (ultra ? " ultra" : "")}>
            <span className="ep-fill" style={{ width: stopCalc(viewFrac ?? fractionOf(shownIdx, levels.length)) }} />
            {levels.map((l, i) => (
              <span
                key={l.id}
                className={"ep-dot" + (isUltracode(l.id) ? " ultra" : "")}
                style={stopStyle(fractionOf(i, levels.length))}
              />
            ))}
            {gridOn && <UltraGridCanvas frac={viewFrac ?? fractionOf(shownIdx, levels.length)} />}
          </div>
          <span
            className={"ep-thumb" + (ultra ? " ultra" : "")}
            style={stopStyle(viewFrac ?? fractionOf(shownIdx, levels.length))}
          />
        </div>
      </div>
    </div>
  );
}
