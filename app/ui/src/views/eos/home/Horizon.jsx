import { useLayoutEffect, useRef, useState } from "react";
import { BUCKETS, bucketTitle, clockOf, dayStart, horizonBuckets, horizonSummary } from "./homeWords.js";

// The day as an arc (Main.dc.html, Transition.dc.html): the crest of one
// great circle centred on the page. The day runs across the content column;
// the circle goes on past it and out of the page at both sides, fading only
// in the last few pixels before each edge. The circle is 1800 px across in a
// page that size or smaller and grows with a wider page, so it always leaves
// at the edges rather than turning down inside them. Solid up to now, dashed
// after; one dot a 15-minute bucket in its most urgent state, the now dot
// brightest. The field's rings start from this circle (`data-r`).
export const ARC_R = 900;
export const ARC_TOP = 8;
// The column the day runs across, at its widest.
const DAY_W = 760;
// How far below its crest the circle may be where it leaves a wide page.
const EDGE_DROP = 320;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE = { waiting: 8, now: 7, done: 6, scheduled: 7 };
// The fade at the page's own edges.
const EDGE = 72;
// The now label sits this far under the arc; an end label it would touch steps aside.
const NOW_DROP = 12;
const END_GAP = 56;
// The end clocks sit just inside the circle, over the arc where the day
// starts and ends (54 px down with the 1800 px circle, as Main.dc.html).
const END_RISE = 28;

// The circle for a page this wide: 1800 across, or larger so that where it
// leaves the page it is at most EDGE_DROP below its crest.
export function arcRadius(page) {
  const half = page / 2;
  return Math.max(ARC_R, Math.ceil((half * half + EDGE_DROP * EDGE_DROP) / (2 * EDGE_DROP)));
}

// How far below the crest the circle is at `dx` from its centre.
const dropAt = (r, dx) => r - Math.sqrt(Math.max(0, r * r - dx * dx));

// The sky's height: down to where the circle leaves the page, and a little more.
export function skyHeight(page) {
  return Math.ceil(ARC_TOP + dropAt(arcRadius(page), page / 2) + 16);
}

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

// Opaque across the page, fading to nothing over the last EDGE pixels at
// each side, so the circle runs out of the window instead of being cut.
export function skyMask(page) {
  const edge = Math.min(EDGE, page * 0.06);
  const px = (v) => `${Math.round(v)}px`;
  return `linear-gradient(to right, transparent, #000 ${px(edge)}, #000 ${px(page - edge)}, transparent)`;
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
  const r = arcRadius(page);
  const sky = skyHeight(page);
  const cy = ARC_TOP + r;
  const cx = page / 2;
  const left = cx - day / 2;
  const at = (fraction) => {
    const x = left + Math.max(0.005, Math.min(0.995, fraction)) * day;
    return { x, y: cy - Math.sqrt(r * r - (x - cx) ** 2) };
  };
  const nowAt = at((now - dayStart(now)) / DAY_MS);
  const nowLeft = nowAt.x - left;
  const endTop = Math.max(0, Math.round(cy - Math.sqrt(r * r - (day / 2 - 20) ** 2) - END_RISE));
  const buckets = horizonBuckets(runs, scheduled, now, names);
  const box = `0 0 ${page} ${sky}`;
  const mask = skyMask(page);
  return (
    <div ref={ref} className="eos-horizon" role="img" aria-label={horizonSummary(runs, scheduled, now)}>
      <div className="eos-horizon__sky" style={{ width: page, marginLeft: -page / 2 }} data-r={r} aria-hidden="true">
        <svg className="eos-horizon__line" viewBox={box} width={page} height={sky} style={{ maskImage: mask, WebkitMaskImage: mask }}>
          <defs>
            <clipPath id="eos-horizon-past"><rect x="0" y="0" width={nowAt.x} height={sky} /></clipPath>
            <clipPath id="eos-horizon-future"><rect x={nowAt.x} y="0" width={page} height={sky} /></clipPath>
          </defs>
          <circle className="eos-horizon__day" cx={cx} cy={cy} r={r} clipPath="url(#eos-horizon-future)" />
          <circle className="eos-horizon__past" cx={cx} cy={cy} r={r} clipPath="url(#eos-horizon-past)" />
        </svg>
        <svg className="eos-horizon__marks" viewBox={box} width={page} height={sky}>
          {buckets.map((b) => <Dot key={b.index} bucket={b} at={at} />)}
          <circle className="eos-horizon__now-halo" cx={nowAt.x} cy={nowAt.y} r={8.5} />
          <circle className="eos-horizon__now" cx={nowAt.x} cy={nowAt.y} r={4.5} />
        </svg>
      </div>
      {nowLeft > END_GAP && <span className="eos-horizon__clock eos-horizon__clock--start" style={{ top: endTop }} aria-hidden="true">00:00</span>}
      <span className="eos-horizon__clock eos-horizon__clock--now" style={{ left: nowLeft, top: nowAt.y + NOW_DROP }} aria-hidden="true">{clockOf(now)}</span>
      {day - nowLeft > END_GAP && <span className="eos-horizon__clock eos-horizon__clock--end" style={{ top: endTop }} aria-hidden="true">24:00</span>}
    </div>
  );
}
