import { fmtCost } from "../../../lib/format.js";
import { duration, hasEnded } from "./words.js";

// What the run has cost and taken so far, against what a run of its routine
// usually costs and takes (D7: the run's own cost and working time).
export function RunCost({ run, usual }) {
  const ended = hasEnded(run);
  return (
    <section className="eos-run-aside__part">
      <h2 className="eos-label">{ended ? "In all" : "So far"}</h2>
      <p className="eos-run-aside__text">
        {duration(run.workMs)} and {fmtCost(run.costUsd)}.
        {usual && ` A run usually takes ${duration(usual.ms)} and ${fmtCost(usual.usd)}.`}
      </p>
    </section>
  );
}
