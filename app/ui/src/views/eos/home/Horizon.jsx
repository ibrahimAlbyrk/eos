import { useLayoutEffect, useRef, useState } from "react";
import { BUCKETS, bucketTitle, clockOf, dayStart, horizonBuckets, horizonSummary } from "./homeWords.js";

// The day as an arc (Main.dc.html, Transition.dc.html): the crest of one
// great circle, 1800 px across, centred on the page. The day runs across the
// content column; the circle goes on past it to both sides of the page and
// fades into the dark before it reaches an edge or turns down. Solid up to
// now, dashed after; one dot a 15-minute bucket in its most urgent state, the
// now dot brightest. The field's rings start from this circle.
export const ARC_R = 900;
export const ARC_TOP = 8;
// The column the day runs across, at its widest.
const DAY_W = 760;
// How far down the sky is drawn: below it the arc has faded out.
const SKY_H = 480;
const CY = ARC_TOP + ARC_R;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE = { waiting: 8, now: 7, done: 6, scheduled: 7 };
// Where the arc is fully drawn and where it has faded, from the centre.
const FULL_TO = 430;
const GONE_AT = 880;
// The fade at the page's own edges.
const EDGE = 160;
// The now label sits this far under the arc; an end label it would touch steps aside.
const NOW_DROP = 12;
const END_GAP = 56;

// The width of the page the sky spans and of the column the day runs across:
// the Home scroll area, measured; 1800 and 760 before it is laid out.
function useSpan(ref) {
  const [span, setSpan] = useState({ page: 2 * ARC_R, day: DAY_W });
  useLayoutEffect(() => {
    const el = ref.current;
    const page = el?.closest(".eos-home__scroll") ?? el?.parentElement;
    if (!el || !page || typeof ResizeObserver === "undefined") return undefined;
    const read = () => {
      if (!page.clientWidth || !el.clientWidth) return;
      setSpan((was) => (was.page === page.clientWidth && was.day === el.clientWidth ? was : { page: page.clientWidth, day: el.clientWidth }));
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(page);
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return span;
}

// Transparent at the page's edges and past GONE_AT from the centre, opaque
// between EDGE and FULL_TO; and fading downwards over the sky's lower half,
// so where the circle turns down it melts into the dark instead of ending at
// the sky's foot.
export function skyMask(page) {
  const cx = page / 2;
  const edge = Math.min(EDGE, page * 0.1);
  const gone = Math.max(0, cx - GONE_AT);
  const full = Math.max(edge, cx - FULL_TO, gone + 1);
  const px = (v) => `${Math.round(v)}px`;
  return `linear-gradient(to right, transparent ${px(gone)}, #000 ${px(full)}, #000 ${px(page - full)}, transparent ${px(page - gone)}), linear-gradient(to bottom, #000 ${px(SKY_H / 2)}, transparent ${px(SKY_H)})`;
}

function Dot({ bucket, at }) {
  const { x, y } = at((bucket.index + 0.5) / BUCKETS);
  return (
    <circle className={`eos-horizon__dot eos-horizon__dot--${bucket.state}`} data-routine={bucket.routineId} cx={x} cy={y} r={SIZE[bucket.state] / 2}>
      <title>{bucketTitle(bucket)}</title>
    </circle>
  );
}

// `runs`: today's RunSummary rows (others are left out); `scheduled`:
// [{ routineId, at }]; `names`: routine id → name.
export function Horizon({ runs, scheduled, names, now }) {
  const ref = useRef(null);
  const { page, day } = useSpan(ref);
  const cx = page / 2;
  const left = cx - day / 2;
  const at = (fraction) => {
    const x = left + Math.max(0.005, Math.min(0.995, fraction)) * day;
    return { x, y: CY - Math.sqrt(ARC_R * ARC_R - (x - cx) ** 2) };
  };
  const nowAt = at((now - dayStart(now)) / DAY_MS);
  const nowLeft = nowAt.x - left;
  const buckets = horizonBuckets(runs, scheduled, now, names);
  const box = `0 0 ${page} ${SKY_H}`;
  const mask = skyMask(page);
  return (
    <div ref={ref} className="eos-horizon" role="img" aria-label={horizonSummary(runs, scheduled, now)}>
      <div className="eos-horizon__sky" style={{ width: page, marginLeft: -page / 2 }} aria-hidden="true">
        <svg className="eos-horizon__line" viewBox={box} width={page} height={SKY_H} style={{ maskImage: mask, WebkitMaskImage: mask, maskComposite: "intersect", WebkitMaskComposite: "source-in" }}>
          <defs>
            <clipPath id="eos-horizon-past"><rect x="0" y="0" width={nowAt.x} height={SKY_H} /></clipPath>
            <clipPath id="eos-horizon-future"><rect x={nowAt.x} y="0" width={page} height={SKY_H} /></clipPath>
          </defs>
          <circle className="eos-horizon__day" cx={cx} cy={CY} r={ARC_R} clipPath="url(#eos-horizon-future)" />
          <circle className="eos-horizon__past" cx={cx} cy={CY} r={ARC_R} clipPath="url(#eos-horizon-past)" />
        </svg>
        <svg className="eos-horizon__marks" viewBox={box} width={page} height={SKY_H}>
          {buckets.map((b) => <Dot key={b.index} bucket={b} at={at} />)}
          <circle className="eos-horizon__now-halo" cx={nowAt.x} cy={nowAt.y} r={8.5} />
          <circle className="eos-horizon__now" cx={nowAt.x} cy={nowAt.y} r={4.5} />
        </svg>
      </div>
      {nowLeft > END_GAP && <span className="eos-horizon__clock eos-horizon__clock--start" aria-hidden="true">00:00</span>}
      <span className="eos-horizon__clock eos-horizon__clock--now" style={{ left: nowLeft, top: nowAt.y + NOW_DROP }} aria-hidden="true">{clockOf(now)}</span>
      {day - nowLeft > END_GAP && <span className="eos-horizon__clock eos-horizon__clock--end" aria-hidden="true">24:00</span>}
    </div>
  );
}
