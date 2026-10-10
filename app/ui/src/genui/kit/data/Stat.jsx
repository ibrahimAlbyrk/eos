import { useView } from "../../runtime/ViewContext.jsx";
import { attrNum, attrText, dataRef } from "../../../../../../contracts/src/genui/attrs.ts";
import { isTone, toneStyle } from "./util.js";
import { sourceName } from "../content/Sources.jsx";
import { Sparkline } from "./Chart.jsx";
import { Icon, hasIcon } from "../icons.jsx";

// Direction of a delta: trend= when given, else its sign.
export function deltaDirection(delta, trend) {
  if (trend === "up" || trend === "down" || trend === "flat") return trend;
  const s = String(delta ?? "").trim();
  if (/^\+/.test(s)) return "up";
  if (/^[-−–]/.test(s)) return "down";
  return "flat";
}

// Whether the delta is good news, bad news or neither. Only good= says which
// way is good (a rising cost is bad, rising revenue good): without it the
// delta stays neutral rather than guessing.
export function deltaMood(dir, good) {
  if (good !== "up" && good !== "down") return "neutral";
  if (dir !== "up" && dir !== "down") return "neutral";
  return dir === good ? "good" : "bad";
}

function sparkValues(v) {
  if (!Array.isArray(v)) return null;
  const nums = v.map(Number).filter(Number.isFinite);
  return nums.length >= 2 ? nums : null;
}

export function Stat({ attrs = {} }) {
  const view = useView();
  const fill = (v) => view.template(attrText(v), undefined);
  const tone = isTone(attrs.tone) ? attrs.tone.toLowerCase() : null;
  const label = fill(attrs.label);
  const value = fill(attrs.value);
  const meta = fill(attrs.meta);
  const src = attrNum(attrs.source);
  const srcName = src != null ? sourceName(view, src) : null;
  const metaLine = srcName ? [meta, srcName].filter(Boolean).join(" · ") : meta;
  const delta = fill(attrs.delta);
  const dir = deltaDirection(delta, attrs.trend);
  const mood = deltaMood(dir, typeof attrs.good === "string" ? attrs.good.toLowerCase() : null);
  // spark= (catalog); values= is tolerated, as on Chart.
  const spark = sparkValues(dataRef(attrs.spark ?? attrs.values, view.data));
  const cls = ["gv-stat", tone && "gv-stat--toned", tone === "red" && "gv-stat--alert"].filter(Boolean).join(" ");
  return (
    <div className={cls} style={toneStyle(tone)}>
      <div className="gv-stat__label">
        {hasIcon(attrs.icon) ? <Icon name={attrs.icon} size={12} className="gv-stat__icon" /> : null}
        {label}
      </div>
      <div className="gv-stat__row">
        <span className="gv-stat__value">{value || "—"}</span>
        {delta ? <span className={`gv-stat__delta gv-stat__delta--${dir} is-${mood}`}>{delta}</span> : null}
      </div>
      {metaLine || src != null ? (
        <div className="gv-stat__meta">
          {metaLine}
          {!srcName && src != null ? <sup className="gv-footref">{src}</sup> : null}
        </div>
      ) : null}
      {spark ? <Sparkline values={spark} height={28} label={label} /> : null}
    </div>
  );
}
