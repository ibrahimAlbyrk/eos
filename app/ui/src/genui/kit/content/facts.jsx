// Rating · Price · Status: the facts a card line is made of, also usable alone.

import { Icon } from "../icons.jsx";
import { useItem, useView } from "../../runtime/ViewContext.jsx";
import { attrNum, attrText } from "../../../../../../contracts/src/genui/attrs.ts";
import { clamp, cls, currencySymbol, formatAmount, formatCount, scopedText, textOf, tpl } from "./util.js";
import { sourceName } from "./Sources.jsx";

// ── rating ──────────────────────────────────────────────────────────────────

// Five stars, the gold row clipped to value/5 so 4.7 fills 94%.
export function Stars({ value, size = 14 }) {
  const pct = clamp((Number(value) / 5) * 100, 0, 100);
  const row = (key) => (
    <span className="gv-stars-row" key={key}>
      {[0, 1, 2, 3, 4].map((i) => <Icon key={i} name="star-solid" size={size} />)}
    </span>
  );
  return (
    <span className="gv-stars" aria-hidden="true">
      {row("off")}
      <span className="gv-stars-on" style={{ width: `${pct}%` }}>{row("on")}</span>
    </span>
  );
}

function ratingText(v) {
  const n = Number(v);
  return Number.isFinite(n) ? (Math.round(n * 10) / 10).toFixed(1) : String(v ?? "");
}

// "★ 4.7" — the compact form inside cards and table cells.
export function RatingInline({ value, count, size = 13 }) {
  if (value == null || value === "") return null;
  return (
    <span className="gv-rating-inline" role="img" aria-label={`Rated ${ratingText(value)} out of 5`}>
      <Icon name="star-solid" size={size} className="gv-star" />
      <b>{ratingText(value)}</b>
      {count != null && count !== "" ? <span className="gv-dim">({formatCount(count)})</span> : null}
    </span>
  );
}

export function Rating({ attrs = {} }) {
  const view = useView();
  const item = useItem();
  const raw = tpl(view, attrs.value, item);
  const value = attrNum(raw);
  if (value == null) return null;
  const count = attrNum(tpl(view, attrs.count, item));
  const src = attrNum(attrs.source);
  const srcName = src != null ? sourceName(view, src) : null;
  return (
    <span className="gv-rating" role="img" aria-label={`Rated ${ratingText(value)} out of 5${count != null ? `, ${formatCount(count)} reviews` : ""}`}>
      <Stars value={value} />
      <b className="gv-rating-value">{ratingText(value)}</b>
      {count != null ? <span className="gv-dim">({formatCount(count)})</span> : null}
      {srcName ? <span className="gv-dim">· {srcName}</span> : src != null ? <sup className="gv-footref">{src}</sup> : null}
    </span>
  );
}

// ── price ───────────────────────────────────────────────────────────────────

// ₺₺ on, ₺₺ dim: a level out of four.
export function PriceLevel({ level, currency }) {
  const n = clamp(Math.round(Number(level)), 1, 4);
  if (!Number.isFinite(n)) return null;
  let sym = currencySymbol(currency);
  if (Array.from(sym).length > 1) sym = "$";
  return (
    <span className="gv-price-level" aria-label={`Price level ${n} of 4`}>
      <span className="gv-price-on" aria-hidden="true">{sym.repeat(n)}</span>
      <span className="gv-price-off" aria-hidden="true">{sym.repeat(4 - n)}</span>
    </span>
  );
}

export function Price({ attrs = {} }) {
  const view = useView();
  const item = useItem();
  const currency = tpl(view, attrs.currency, item) || (item && typeof item.currency === "string" ? item.currency : "");
  const level = attrNum(tpl(view, attrs.level, item));
  const amount = tpl(view, attrs.amount, item);
  const per = tpl(view, attrs.per, item);
  if (level == null && !amount) return null;
  return (
    <span className="gv-price">
      {level != null ? <PriceLevel level={level} currency={currency} /> : null}
      {amount ? <span className="gv-price-amount">{formatAmount(amount, currency)}</span> : null}
      {amount && per ? <span className="gv-dim"> / {per}</span> : null}
    </span>
  );
}

// ── status ──────────────────────────────────────────────────────────────────

const STATUS_LABEL = {
  open: "Open",
  closing: "Closing soon",
  closed: "Closed",
  ok: "OK",
  warn: "Warning",
  error: "Error",
  info: "Info",
  running: "Running",
  idle: "Idle",
};

export function statusLabel(state, until, text) {
  if (text) return text;
  const base = STATUS_LABEL[state] ?? String(state ?? "");
  if (!until) return base;
  return state === "open" ? `${base} · until ${until}` : `${base} · ${until}`;
}

// The dot + text line; `state` picks the color.
export function StatusLine({ state, text, className }) {
  if (!text) return null;
  const s = STATUS_LABEL[state] ? state : "idle";
  return (
    <span className={cls("gv-status", `gv-status-${s}`, className)}>
      <span className="gv-status-dot" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

export function Status({ attrs = {}, node, children }) {
  const view = useView();
  const item = useItem();
  const state = tpl(view, attrs.state, item).toLowerCase();
  const until = tpl(view, attrs.until, item);
  const text = scopedText(view, textOf(node, children), item);
  return <StatusLine state={state} text={statusLabel(state, until, text.trim())} />;
}

// What a place's hours/status say right now, as {state, text}. Data-driven: the
// agent states "closing" — the kit never guesses from the clock.
export function placeStatus(item) {
  if (!item || typeof item !== "object") return null;
  const status = typeof item.status === "string" ? item.status.trim() : "";
  const known = /^(open|closing|closed)$/i.test(status) ? status.toLowerCase() : null;
  const h = item.hours;
  if (h && typeof h === "object" && !Array.isArray(h)) {
    const text = attrText(h.text);
    if (h.closed === true || known === "closed") return { state: "closed", text: text || "Closed" };
    const until = attrText(h.until);
    const state = known ?? "open";
    if (until) return { state, text: statusLabel(state, until) };
    if (text) return { state, text };
    return known ? { state, text: statusLabel(state) } : null;
  }
  if (typeof h === "string" && h.trim()) return { state: known ?? "info", text: known ? statusLabel(known, null, h.trim()) : h.trim() };
  if (known) return { state: known, text: statusLabel(known) };
  if (status) return { state: "info", text: status };
  return null;
}
