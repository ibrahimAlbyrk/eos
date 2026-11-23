import { BUCKETS, bucketTitle, clockOf, dayStart, horizonBuckets, horizonSummary } from "./homeWords.js";

// The day as an arc (Main.dc.html): a circle far larger than the band, so
// only its crest shows. Dashed for the whole day, solid up to now; one dot a
// 15-minute bucket in its most urgent state, the now dot brightest.
const W = 760;
const H = 96;
const R = 900;
const CX = W / 2;
const CY = 8 + R;
const DAY_MS = 24 * 60 * 60 * 1000;

const yAt = (x) => CY - Math.sqrt(R * R - (x - CX) ** 2);
const xOf = (fraction) => Math.max(4, Math.min(W - 4, fraction * W));
const ARC = `M0 ${yAt(0).toFixed(1)} A${R} ${R} 0 0 1 ${W} ${yAt(W).toFixed(1)}`;
const SIZE = { waiting: 8, now: 7, done: 6, scheduled: 7 };

function Dot({ bucket }) {
  const x = xOf((bucket.index + 0.5) / BUCKETS);
  const r = SIZE[bucket.state] / 2;
  return (
    <circle className={`eos-horizon__dot eos-horizon__dot--${bucket.state}`} cx={x} cy={yAt(x)} r={r}>
      <title>{bucketTitle(bucket)}</title>
    </circle>
  );
}

// `runs`: today's RunSummary rows (others are left out); `scheduled`:
// [{ routineId, at }]; `names`: routine id → name.
export function Horizon({ runs, scheduled, names, now }) {
  const nowX = xOf((now - dayStart(now)) / DAY_MS);
  const buckets = horizonBuckets(runs, scheduled, now, names);
  return (
    <div className="eos-horizon" role="img" aria-label={horizonSummary(runs, scheduled, now)}>
      <svg className="eos-horizon__arc" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <defs>
          <clipPath id="eos-horizon-past"><rect x="0" y="0" width={nowX} height={H} /></clipPath>
        </defs>
        <path className="eos-horizon__day" d={ARC} />
        <path className="eos-horizon__past" d={ARC} clipPath="url(#eos-horizon-past)" />
        {buckets.map((b) => <Dot key={b.index} bucket={b} />)}
        <circle className="eos-horizon__now-halo" cx={nowX} cy={yAt(nowX)} r={8.5} />
        <circle className="eos-horizon__now" cx={nowX} cy={yAt(nowX)} r={4.5} />
      </svg>
      <span className="eos-horizon__clock eos-horizon__clock--start" aria-hidden="true">00:00</span>
      <span className="eos-horizon__clock eos-horizon__clock--now" style={{ left: `${(nowX / W) * 100}%` }} aria-hidden="true">{clockOf(now)}</span>
      <span className="eos-horizon__clock eos-horizon__clock--end" aria-hidden="true">24:00</span>
    </div>
  );
}
