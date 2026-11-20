import { useEffect } from "react";
import { dismissResumed, ensureHaltLoaded, resumeEos, useHalt } from "../../../state/eos/haltStore.js";
import { timeAt } from "../routine/words.js";
import { openLocation } from "./eosNav.js";

// Under every Eos screen's header while Eos is stopped on this Mac (03 G10):
// what that means, with Resume. Once resumed here, where what was stopped
// waits. Eos's own words and controls, drawn outside any surface.
export function HaltBand() {
  const { halt, resumed } = useHalt();
  useEffect(() => { ensureHaltLoaded(); }, []);
  if (halt?.on) {
    return (
      <div className="eos-band eos-band--err eos-halt" role="status">
        <span className="eos-band__text">
          Eos is stopped{halt.since != null ? ` since ${timeAt(halt.since)}` : ""}. No routine runs and nothing is sent until you resume.
        </span>
        <button type="button" className="eos-btn eos-btn--primary" onClick={() => void resumeEos()}>Resume</button>
      </div>
    );
  }
  if (!resumed) return null;
  return (
    <div className="eos-band eos-halt" role="status">
      <span className="eos-band__text">Eos runs again. Sends that were stopped wait in Needs you.</span>
      <button type="button" className="eos-btn" onClick={() => { dismissResumed(); openLocation("eos:/needs"); }}>Open Needs you</button>
      <button type="button" className="eos-btn" onClick={dismissResumed}>OK</button>
    </div>
  );
}
