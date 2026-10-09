import { useEffect, useId, useRef, useState } from "react";
import { useView } from "../../runtime/ViewContext.jsx";
import { attrBool, attrNum, attrText, splitIds } from "../../../../../../contracts/src/genui/attrs.ts";
import { formatNumber, withUnit } from "./format.js";
import { applyLens, itemId, mix, seriesColors } from "./util.js";
import {
  DONUT_R,
  areaBetween,
  areaPath,
  bandXs,
  barPath,
  chartData,
  donutSegments,
  labelStride,
  linePath,
  nearestIndex,
  niceScale,
  pointXs,
  scaleY,
  valueExtent,
} from "./chartGeom.js";
import { FilterEmpty } from "../inputs/FilterEmpty.jsx";

const DEFAULT_HEIGHT = { bar: 120, line: 150, area: 150, donut: 110, sparkline: 32 };
const DIM_BASE = "#171717";

// Width of a box, tracked with a ResizeObserver; `fallback` until measured
// (and in static rendering).
function useWidth(fallback) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect?.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function fmt(v, unit) {
  return v == null ? "—" : withUnit(formatNumber(v), unit);
}

function axisText(v, unit) {
  return withUnit(formatNumber(v, { format: Math.abs(v) >= 10000 ? "compact" : "number" }), unit);
}

function describe(type, labels, series, unit) {
  const s = series[0];
  if (!s) return `${type} chart, no data`;
  const pts = labels.slice(0, 8).map((l, i) => `${l} ${fmt(s.values[i], unit)}`);
  return `${type} chart: ${pts.join(", ")}${labels.length > 8 ? ", …" : ""}`;
}

const pct = (x, width) => `${((x / Math.max(1, width)) * 100).toFixed(3)}%`;

function Tooltip({ x, width, label, rows, unit }) {
  return (
    <div className="gv-chart__tip" style={{ left: `clamp(48px, ${pct(x, width)}, calc(100% - 48px))` }} role="presentation">
      <div className="gv-chart__tiplabel">{label}</div>
      {rows.map((r) => (
        <div className="gv-chart__tipval" key={r.key}>
          {rows.length > 1 ? <span className="gv-chart__swatch" style={{ background: r.color }} /> : null}
          {rows.length > 1 ? <span className="gv-chart__tipkey">{r.key}</span> : null}
          {fmt(r.value, unit)}
        </div>
      ))}
    </div>
  );
}

// Arrow keys walk the points; Escape clears.
function useActive(n) {
  const [active, setActive] = useState(null);
  const onKeyDown = (e) => {
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setActive((a) => (a == null ? (step > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, a + step))));
    } else if (e.key === "Escape") setActive(null);
  };
  return [active, setActive, onKeyDown];
}

function Cartesian({ type, labels, series, colors, height, unit, stacked, onPick, selectedIndex }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [ref, width] = useWidth(560);
  const [active, setActive, onKeyDown] = useActive(labels.length);
  const isBar = type === "bar";
  const padL = isBar ? 2 : 36;
  const padR = isBar ? 2 : 10;
  const padT = 10;
  const padB = 20;
  const top = padT;
  const bottom = height - padB;
  const [lo0, hi0] = valueExtent(series, { stacked, zero: isBar });
  const scale = isBar ? { min: Math.min(0, lo0), max: hi0 || 1, ticks: [] } : niceScale(lo0, hi0, 3);
  const y = (v) => scaleY(v, scale.min, scale.max, top, bottom);
  const n = labels.length;
  const band = bandXs(n, padL, width - padR);
  const xs = isBar ? band.xs : pointXs(n, padL, width - padR);
  const stride = labelStride(n, width - padL - padR);
  const shown = active ?? selectedIndex ?? null;
  const single = series.length === 1;
  const maxIdx = single ? series[0].values.reduce((b, v, i, a) => (v != null && (a[b] == null || v > a[b]) ? i : b), 0) : -1;
  const highlight = shown ?? (isBar && single ? maxIdx : null);

  const pointer = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * width;
    setActive(nearestIndex(xs, px));
  };

  const shapes = [];
  if (isBar) {
    const groups = stacked || single ? 1 : series.length;
    // Few wide bands still get slim bars (the board's bars are ~30px).
    const barW = Math.min(band.bar, groups > 1 ? 22 * groups : 48);
    const sub = barW / groups;
    const base = new Array(n).fill(0);
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v == null) return;
        const from = stacked ? base[i] : 0;
        const to = from + v;
        if (stacked) base[i] = to;
        const x = band.xs[i] - barW / 2 + (groups > 1 ? si * sub : 0);
        const w = groups > 1 ? Math.max(2, sub - 2) : barW;
        const yTop = y(Math.max(from, to));
        const h = Math.abs(y(from) - y(to));
        const lit = highlight == null || highlight === i;
        const color = single ? (lit && highlight != null ? colors[0] : mix(colors[0], DIM_BASE, 0.25)) : colors[si];
        shapes.push(
          <path
            key={`b${si}-${i}`}
            d={barPath(x, yTop, w, h, stacked && si < series.length - 1 ? 0 : 6, stacked && si > 0 ? 0 : 2)}
            fill={color}
            opacity={!single && !lit ? 0.45 : 1}
          />,
        );
      });
    });
  } else {
    const lower = xs.map((x) => ({ x, y: y(Math.max(0, scale.min)) }));
    let running = new Array(n).fill(0);
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => {
        if (v == null) return null;
        return { x: xs[i], y: y(stacked ? running[i] + v : v) };
      });
      const fillId = `gvar-${uid}-${si}`;
      if (type === "area") {
        shapes.push(
          <defs key={`d${si}`}>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={colors[si]} stopOpacity={single ? 0.28 : 0.22} />
              <stop offset="1" stopColor={colors[si]} stopOpacity="0" />
            </linearGradient>
          </defs>,
        );
        const prev = stacked && si > 0 ? running.map((v, i) => ({ x: xs[i], y: y(v) })) : null;
        shapes.push(<path key={`a${si}`} d={prev ? areaBetween(pts, prev) : areaPath(pts, lower[0].y)} fill={`url(#${fillId})`} />);
      }
      shapes.push(<path key={`l${si}`} d={linePath(pts)} fill="none" stroke={colors[si]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />);
      if (stacked) running = running.map((r, i) => r + (s.values[i] ?? 0));
    });
  }

  const tipRows =
    shown != null
      ? series.map((s, si) => ({ key: s.key, value: s.values[shown], color: colors[si] }))
      : [];
  let stackTop = 0;
  return (
    <div className={`gv-chart gv-chart--${type}`} ref={ref}>
      <div
        className="gv-chart__plot"
        tabIndex={0}
        role="img"
        aria-label={describe(type, labels, series, unit)}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          onPointerMove={pointer}
          onPointerLeave={() => setActive(null)}
          onClick={onPick && shown != null ? () => onPick(shown) : undefined}
          aria-hidden="true"
        >
          {!isBar ? (
            <g className="gv-chart__grid">
              {scale.ticks.map((t) => (
                <line key={t} x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          ) : (
            <line className="gv-chart__base" x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
          )}
          {shapes}
          {!isBar && shown != null ? (
            <g>
              <line className="gv-chart__cursor" x1={xs[shown]} x2={xs[shown]} y1={top} y2={bottom} vectorEffect="non-scaling-stroke" />
              {series.map((s, si) => {
                const v = s.values[shown];
                if (v == null) return null;
                stackTop = stacked ? stackTop + v : v;
                return <circle key={si} cx={xs[shown]} cy={y(stacked ? stackTop : v)} r="5" fill={colors[si]} stroke="#101010" strokeWidth="2" />;
              })}
            </g>
          ) : null}
        </svg>
        {/* Axis text is HTML laid over the plot: the SVG stretches to its box
            (preserveAspectRatio="none"), and text inside it would stretch too
            until the width is measured. */}
        {!isBar ? (
          <div className="gv-chart__ylabels" aria-hidden="true">
            {scale.ticks.map((t) => (
              <span key={t} style={{ top: y(t) }}>
                {axisText(t, unit)}
              </span>
            ))}
          </div>
        ) : null}
        <div className="gv-chart__xlabels" aria-hidden="true" style={{ top: height - padB + 3 }}>
          {labels.map((l, i) =>
            i % stride === 0 || i === highlight ? (
              <span
                key={i}
                className={[!isBar && i === 0 ? "is-start" : !isBar && i === n - 1 ? "is-end" : "", i === highlight ? "is-on" : ""].filter(Boolean).join(" ") || undefined}
                style={{ left: pct(xs[i], width), ...(i === highlight ? { color: colors[0] } : null) }}
              >
                {l}
              </span>
            ) : null,
          )}
        </div>
        {shown != null ? <Tooltip x={xs[shown]} width={width} label={labels[shown]} rows={tipRows} unit={unit} /> : null}
      </div>
    </div>
  );
}

function Donut({ labels, series, colors, unit }) {
  const [active, setActive, onKeyDown] = useActive(labels.length);
  const values = series[0]?.values ?? [];
  const segs = donutSegments(values);
  const palette = colors.length >= labels.length ? colors : seriesColors(null, labels.length);
  return (
    <div className="gv-chart gv-chart--donut">
      <div className="gv-chart__donut" tabIndex={0} role="img" aria-label={describe("donut", labels, series, unit)} onKeyDown={onKeyDown} onBlur={() => setActive(null)}>
        <svg width="96" height="96" viewBox="0 0 42 42" aria-hidden="true" onPointerLeave={() => setActive(null)}>
          <circle cx="21" cy="21" r={DONUT_R} fill="none" stroke="#242424" strokeWidth="5" />
          {segs.map((s, i) =>
            s.frac > 0 ? (
              <circle
                key={i}
                cx="21"
                cy="21"
                r={DONUT_R}
                fill="none"
                stroke={palette[i % palette.length]}
                strokeWidth={active === i ? 6.2 : 5}
                strokeDasharray={s.dash}
                strokeDashoffset={s.offset}
                opacity={active == null || active === i ? 1 : 0.45}
                onPointerEnter={() => setActive(i)}
              />
            ) : null,
          )}
        </svg>
      </div>
      <ul className="gv-chart__legend">
        {labels.map((l, i) => (
          <li
            key={i}
            className={active === i ? "is-on" : undefined}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
          >
            <span className="gv-chart__swatch" style={{ background: palette[i % palette.length] }} />
            <span className="gv-chart__legkey">{l}</span>
            <span className="gv-chart__legval">
              {segs[i] ? formatNumber(segs[i].frac, { format: "percent", decimals: 0 }) : "—"}
              {active === i && values[i] != null ? <span className="gv-chart__legabs"> · {fmt(values[i], unit)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Tiny trend line (Stat tiles, <Chart type="sparkline">).
export function Sparkline({ values, height = 32, color, label }) {
  const nums = values.filter((v) => v != null);
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const xs = pointXs(values.length, 1, 159);
  const pts = values.map((v, i) => (v == null ? null : { x: xs[i], y: scaleY(v, lo, hi === lo ? lo + 1 : hi, 3, height - 3) }));
  const last = [...pts].reverse().find(Boolean);
  return (
    <svg className="gv-spark" width="100%" height={height} viewBox={`0 0 160 ${height}`} preserveAspectRatio="none" role="img" aria-label={label ? `${label} trend` : "trend"}>
      <path d={linePath(pts)} fill="none" style={{ stroke: color ?? "var(--gv-accent, #6ea4e8)" }} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {last ? <circle cx={last.x} cy={last.y} r="2" style={{ fill: color ?? "var(--gv-accent, #6ea4e8)" }} /> : null}
    </svg>
  );
}

export function Chart({ attrs = {} }) {
  const view = useView();
  const type = ["bar", "line", "area", "donut", "sparkline"].includes(attrs.type) ? attrs.type : "bar";
  const of = typeof attrs.of === "string" ? attrs.of : null;
  const items = of ? applyLens(view.collection(of), attrs, view.state) : null;
  if (of && !items.length) return <FilterEmpty of={of} />;
  const values = Array.isArray(attrs.values) ? attrs.values : null;
  const data = chartData(items, { x: attrText(attrs.x) || undefined, y: splitIds(attrs.y), values });
  if (!data.series.length || !data.labels.length) return null;
  const unit = view.template(attrText(attrs.unit), undefined);
  const height = attrNum(attrs.height) ?? DEFAULT_HEIGHT[type];
  const colors = seriesColors(view.tone, Math.max(data.series.length, type === "donut" ? data.labels.length : 1));
  if (type === "donut") return <Donut labels={data.labels} series={data.series} colors={colors} unit={unit} />;
  if (type === "sparkline") return <Sparkline values={data.series[0].values} height={height} color={colors[0]} />;
  const sel = of ? view.selected(of) : null;
  const selectedIndex = of && sel != null ? items.findIndex((it, i) => itemId(it, i) === String(sel)) : -1;
  return (
    <Cartesian
      type={type}
      labels={data.labels}
      series={data.series}
      colors={colors}
      height={height}
      unit={unit}
      stacked={attrBool(attrs.stacked)}
      selectedIndex={selectedIndex >= 0 ? selectedIndex : null}
      onPick={of ? (i) => view.select(of, itemId(items[i], i)) : null}
    />
  );
}

