import { Stations } from "../frame.jsx";
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

// A change to the page goes through four stations: the user points or says,
// Eos redraws, the new version is checked, and it is the user's to keep.
const STATIONS = ["Point or say", "Eos redraws", "Checked", "Yours to keep"];

// Where a change stands: the station, its tone and word, and the lead.
function standing({ surface, candidate, design, working, kept }) {
  if (kept) return { at: 3, tone: "ok", word: "kept", lead: `Kept. The next issue follows version ${kept}.` };
  if (candidate?.meta.status === "candidate") {
    return { at: 3, tone: "active", word: "ready", lead: `Version ${candidate.meta.version} is ready.`, now: candidate.meta.note, offer: true };
  }
  const phase = design?.phase;
  if (phase === "failed") {
    return { at: 2, tone: "err", word: "did not pass", lead: designLine(phase, design.version), now: "The page stays as it was; say it another way, or point at a part.", failed: true };
  }
  if (phase === "checking" || phase === "waiting") {
    return { at: 2, tone: phase === "waiting" ? "warn" : "active", word: phase === "waiting" ? "waits" : "checking", working: phase === "checking", lead: designLine(phase, design.version) };
  }
  if (working) return { at: 1, tone: "active", word: "drawing", working: true, lead: "Eos is changing the page…", now: "You see the new version once it passes its checks." };
  return { at: 0, tone: "active", word: "now", lead: "Click any part of the page, then say what should change there.", now: `Version ${surface.currentVersion} stays until you keep a new one.` };
}

// The lead of reshape mode: what to do, the designer at work, a version that
// did not pass with what failed, or the new version with Before and After,
// Keep and Go back; then the way a change goes, as stations.
export function ReshapeBar({ surface, candidate, failed, design, working, kept, showing, onShow, onKeep, onRevert, onStop }) {
  const s = standing({ surface, candidate, design, working, kept });
  const findings = s.failed ? failedFindings(failed?.checks) : [];
  const nowClass = s.failed ? "eos-rlead__now eos-rlead__now--err" : "eos-rlead__now";
  return (
    <header className="eos-rlead eos-reshape__lead" role="status">
      <p className="eos-label">Changing the page</p>
      <p className="eos-lead">{s.lead}</p>
      {s.now && <p className={nowClass}>{s.now}</p>}
      {findings.length > 0 && <ul className="eos-reshape__findings">{findings.map((f) => <li key={f}>{f}</li>)}</ul>}
      {s.offer && (
        <div className="eos-rlead__acts">
          <button type="button" className="eos-btn eos-btn--primary" onClick={onKeep}>Keep version {candidate.meta.version}</button>
          <button type="button" className="eos-btn eos-btn--quiet" onClick={onRevert}>Go back to {surface.currentVersion}</button>
          <BeforeAfter showing={showing} onShow={onShow} />
        </div>
      )}
      {working && !s.offer && (
        <div className="eos-rlead__acts"><button type="button" className="eos-btn" onClick={onStop}>Cancel</button></div>
      )}
      <Stations names={STATIONS} at={s.at} tone={s.tone} working={s.working} words={STATIONS.map((_, i) => (i === s.at ? s.word : ""))} />
    </header>
  );
}
