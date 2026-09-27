import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { fmtTokens } from "../../../lib/format.js";
import { summarySections } from "../../../lib/compactionSummary.js";
import { useFx } from "../../../state/compactionStore.js";
import { createGalaxy, paintStars, sizeCanvas, starLayout } from "./compaction/galaxy.js";

// The class that blanks the card's text while the nebula's dust writes it.
export const ASSEMBLING_CLASS = "is-assembling";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// A card's live stage: while a compaction the view watched is landing, the
// nebula overlay drives it (assembling → settling); otherwise it rests ("done").
function useStage(workerId, block) {
  const fx = useFx(workerId);
  const mine = fx && (fx.cardId === block.id || (fx.stage === "running" && block.ts >= fx.since));
  if (!mine) return { stage: "done", live: false };
  return { stage: fx.stage === "running" ? "assembling" : fx.stage, live: true };
}

// The icon-slot galaxy and the header stars. They paint only while on screen,
// and hold still under reduced motion.
function useSky(sealRef, starRef, seed, active, spinRef) {
  useEffect(() => {
    if (!active) return;
    const seal = sealRef.current, sky = starRef.current;
    if (!seal || !sky) return;
    const a = sizeCanvas(seal), b = sizeCanvas(sky);
    const galaxy = createGalaxy(seed);
    const stars = starLayout(seed, b.w, b.h);
    if (reducedMotion()) {
      galaxy.paint(a.g, a.w, a.h, 0, 0);
      paintStars(b.g, b.w, b.h, stars, 0);
      return;
    }
    let raf = 0, last = performance.now(), t = 0, visible = true;
    const frame = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      t += dt;
      spinRef.current += (1 - spinRef.current) * Math.min(1, dt / 500);
      galaxy.paint(a.g, a.w, a.h, dt, spinRef.current);
      paintStars(b.g, b.w, b.h, stars, t);
      if (visible) raf = requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      cancelAnimationFrame(raf);
      if (visible) { last = performance.now(); raf = requestAnimationFrame(frame); }
    });
    io.observe(seal);
    raf = requestAnimationFrame(frame);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [active, seed, sealRef, starRef, spinRef]);
}

// Counts the token figure down from before → after once, when a live landing
// finishes; a resting card just shows the result.
function useTokenCount(block, live, stage) {
  const [value, setValue] = useState(live ? block.beforeTokens : block.afterTokens);
  const counted = useRef(!live);
  useEffect(() => {
    if (stage !== "done" || counted.current) return;
    counted.current = true;
    const from = block.beforeTokens, to = block.afterTokens, t0 = performance.now();
    let raf = 0;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 1300);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      setValue(from + (to - from) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [stage, block.beforeTokens, block.afterTokens]);
  return { value, settled: counted.current && value === block.afterTokens };
}

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3.5L10.5 8 6 12.5" />
  </svg>
);

// The compaction boundary: a tiny living galaxy (the cloud that condensed the
// conversation) and the stars its leftover dust became. Opens to the summary the
// agent continues from; the conversation before it folds behind "earlier
// conversation" above the card.
export function CompactionCard({ block, workerId, hasHistory, historyOpen, onToggleHistory }) {
  const [open, setOpen] = useState(false);
  const sealRef = useRef(null);
  const starRef = useRef(null);
  const spinRef = useRef(1);
  const { stage, live } = useStage(workerId, block);
  const sections = useMemo(() => summarySections(block.summary), [block.summary]);
  const tokens = useTokenCount(block, live, stage);
  useSky(sealRef, starRef, block.id ?? 1, stage !== "assembling", spinRef);

  const meta = `${block.turns} turn${block.turns === 1 ? "" : "s"} · ${block.trigger === "manual" ? "/compact" : `auto at ${block.pct ?? "?"}%`}`;
  const toggle = () => {
    setOpen((o) => !o);
    spinRef.current = 5; // the galaxy spins up briefly as the card opens
  };

  return (
    <div className="cmp-wrap">
      {hasHistory && (
        <button type="button" className="cmp-history" onClick={onToggleHistory} aria-expanded={historyOpen}>
          {historyOpen ? "Hide earlier conversation" : `Show earlier conversation · ${block.turns} turn${block.turns === 1 ? "" : "s"}`}
        </button>
      )}
      <div
        className={["cmp-card", stage !== "done" ? (stage === "assembling" ? ASSEMBLING_CLASS : `is-${stage}`) : null, open ? "open" : null].filter(Boolean).join(" ")}
        data-compaction-card={block.id}
      >
        <canvas className="cmp-star-cv" ref={starRef} aria-hidden="true" />
        <div className="cmp-head">
          <span className="cmp-ic"><canvas className="cmp-seal-cv" ref={sealRef} aria-hidden="true" /></span>
          <span className="cmp-title">Conversation compacted</span>
          <span className="cmp-meta">{meta}</span>
          <span className={"cmp-tok mono" + (tokens.settled ? " settled" : "")}>
            <span className="cmp-tok__from">{fmtTokens(block.beforeTokens)}</span>
            <span className="cmp-tok__arr">→</span>
            <span className="cmp-tok__to">{fmtTokens(Math.round(tokens.value))}</span>
          </span>
          <button type="button" className="cmp-toggle" onClick={toggle} aria-expanded={open}>
            <span className="cmp-toggle__lbl">Summary</span>
            <Chevron />
          </button>
        </div>
        <div className="cmp-body">
          <div className="cmp-body-in">
            {block.instructions && <p className="cmp-focus">Focus: {block.instructions}</p>}
            <dl className="cmp-secs">
              {sections.map((s, i) => (
                <div className="cmp-sec" key={i}>
                  <dt>{s.title ?? "Summary"}</dt>
                  <dd className="md-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.body) }} />
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CompactionFailedLine({ block }) {
  return (
    <div className="turn-error mono">
      <span className="te-icon" aria-hidden>!</span>
      <span className="te-msg">Compaction failed — {block.error || "unknown error"}. The conversation was kept as it was.</span>
    </div>
  );
}
