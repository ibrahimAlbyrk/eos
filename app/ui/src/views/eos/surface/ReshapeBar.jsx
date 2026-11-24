import { BeforeAfter } from "./BeforeAfter.jsx";
import { designLine, findingLine } from "./words.js";

// The probe's findings of a version that failed its checks, once each.
export function failedFindings(checks) {
  const seen = new Set();
  const out = [];
  for (const set of checks?.probe ?? []) {
    for (const width of set.widths ?? []) {
      for (const finding of width.findings ?? []) {
        const line = findingLine(finding);
        if (!seen.has(line)) {
          seen.add(line);
          out.push(line);
        }
      }
    }
  }
  return out;
}

// The bar under the header in reshape mode: what to do, the designer at
// work, or the new version with Before and After, Keep and Go back.
export function ReshapeBar({ surface, candidate, failed, design, working, kept, showing, onShow, onKeep, onRevert, onStop }) {
  if (kept) return <p className="eos-reshape__bar" role="status">Kept. The next issue follows version {kept}.</p>;
  if (candidate && candidate.meta.status === "candidate") {
    return (
      <div className="eos-reshape__bar" role="status">
        <span className="eos-reshape__text">Version {candidate.meta.version}. {candidate.meta.note}</span>
        <BeforeAfter showing={showing} onShow={onShow} />
        <span className="eos-reshape__gap" />
        <button type="button" className="eos-btn eos-btn--primary" onClick={onKeep}>Keep version {candidate.meta.version}</button>
        <button type="button" className="eos-btn" onClick={onRevert}>Go back to {surface.currentVersion}</button>
      </div>
    );
  }
  const phase = design?.phase;
  if (working || phase === "checking" || phase === "waiting") {
    return (
      <div className="eos-reshape__bar" role="status">
        <span className="eos-reshape__dot" aria-hidden="true" />
        <span className="eos-reshape__text">{designLine(phase, design?.version) ?? "Eos is changing the page…"}</span>
        {working && <button type="button" className="eos-btn" onClick={onStop}>Cancel</button>}
      </div>
    );
  }
  if (phase === "failed") {
    const findings = failedFindings(failed?.checks);
    return (
      <div className="eos-reshape__bar eos-reshape__bar--failed" role="status">
        <span className="eos-reshape__text">{designLine(phase, design.version)} The page stays as it was; say it another way, or point at a part.</span>
        {findings.length > 0 && <ul className="eos-reshape__findings">{findings.map((f) => <li key={f}>{f}</li>)}</ul>}
      </div>
    );
  }
  return <p className="eos-reshape__bar eos-reshape__hint">Click any part of the page, then say what should change there.</p>;
}
