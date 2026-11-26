import { fmtUsd } from "../../../lib/format.js";
import { duration, hasEnded } from "./words.js";

// What the run has cost and taken so far, against what a run of its routine
// usually costs and takes (D7: the run's own cost and working time): two
// figures side by side, the usual under each.
// A figure in the aside's 20 px mono, kept to one line: under a minute is
// said short.
const figure = (ms) => (ms >= 60_000 ? duration(ms) : ms > 0 ? "< 1 min" : "0 min");

export function RunCost({ run, usual }) {
  const ended = hasEnded(run);
  const figures = [
    ["Time", figure(run.workMs ?? 0), usual && duration(usual.ms)],
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
