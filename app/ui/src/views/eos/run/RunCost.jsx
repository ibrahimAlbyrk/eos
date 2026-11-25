import { fmtUsd } from "../../../lib/format.js";
import { duration, hasEnded } from "./words.js";

// What the run has cost and taken so far, against what a run of its routine
// usually costs and takes (D7: the run's own cost and working time): two
// figures side by side, the usual under each.
export function RunCost({ run, usual }) {
  const ended = hasEnded(run);
  const figures = [
    ["Time", duration(run.workMs), usual && duration(usual.ms)],
    ["Cost", fmtUsd(run.costUsd), usual && fmtUsd(usual.usd)],
  ];
  return (
    <section className="eos-run-aside__part">
      <h2 className="eos-label">{ended ? "In all" : "So far"}</h2>
      <dl className="eos-run-cost">
        {figures.map(([label, value, usually]) => (
          <div key={label} className="eos-run-cost__fig">
            <dt>{label}</dt>
            <dd className="eos-run-cost__value">{value}</dd>
            {usually && <dd className="eos-run-cost__usual">usually {usually}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
