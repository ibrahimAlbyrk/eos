import { useEffect } from "react";
import { dismissResumed, ensureHaltLoaded, resumeEos, useHalt } from "../../../state/eos/haltStore.js";
import { timeAt } from "../routine/words.js";
import { openLocation } from "./eosNav.js";

const STOP = "M5.5 5.5h5v5h-5z";
const GO = "M5.5 4.5v7l6-3.5z";

function Mark({ d, tone }) {
  return (
    <span className={`eos-ring eos-ring--${tone} eos-halt__mark`} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16"><path d={d} /></svg>
    </span>
  );
}

// Under every Eos screen's header while Eos is stopped on this Mac (03 G10):
// a stop mark in the err ring, the fact in strong words and what it means
// dim, with Resume; the header's hairline takes the err tone too. Once
// resumed here, where what was stopped waits. Eos's own words and controls,
// drawn outside any surface.
export function HaltBand() {
  const { halt, resumed } = useHalt();
  useEffect(() => { ensureHaltLoaded(); }, []);
  if (halt?.on) {
    return (
      <div className="eos-halt eos-halt--stopped" role="status">
        <Mark d={STOP} tone="err" />
        <p className="eos-halt__words">
          <strong>Eos is stopped{halt.since != null ? ` since ${timeAt(halt.since)}` : ""}.</strong> No routine runs and nothing is sent until you resume.
        </p>
        <button type="button" className="eos-btn eos-btn--primary" onClick={() => void resumeEos()}>Resume</button>
      </div>
    );
  }
  if (!resumed) return null;
  return (
    <div className="eos-halt" role="status">
      <Mark d={GO} tone="ok" />
      <p className="eos-halt__words"><strong>Eos runs again.</strong> Sends that were stopped wait in Needs you.</p>
      <button type="button" className="eos-btn" onClick={() => { dismissResumed(); openLocation("eos:/needs"); }}>Open Needs you</button>
      <button type="button" className="eos-btn eos-btn--quiet" onClick={dismissResumed}>OK</button>
    </div>
  );
}
