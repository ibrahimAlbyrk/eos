// What a card shows for each entity type: its kind, its meta line, its facts
// (rating · price · distance · status for a place, price · stock for a product…).

import { Icon } from "../icons.jsx";
import { PriceLevel, RatingInline, StatusLine, placeStatus } from "../content/facts.jsx";
import { formatAmount, siteOf } from "../content/util.js";

export const KINDS = ["place", "product", "event", "person", "article", "media", "file", "generic"];

// kind= on the element wins, then the runtime's reading of the item.
export function kindOf(view, item, override) {
  if (typeof override === "string" && KINDS.includes(override.toLowerCase())) return override.toLowerCase();
  const k = typeof view?.entityKind === "function" ? view.entityKind(item) : item?.type;
  const s = typeof k === "string" ? k.toLowerCase() : "";
  return KINDS.includes(s) ? s : "generic";
}

function str(v) {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

const join = (...parts) => parts.map(str).filter(Boolean).join(" · ");

export function defaultMeta(kind, item) {
  if (!item || typeof item !== "object") return "";
  const own = str(item.meta);
  switch (kind) {
    case "place":
      return join(item.cuisine, item.area) || own || str(item.address);
    case "product": {
      if (own) return own;
      const specs = item.specs && typeof item.specs === "object" ? Object.values(item.specs).slice(0, 3) : [];
      return join(...specs) || str(item.brand);
    }
    case "event":
      return join(item.start, item.venue) || own;
    case "person":
      return join(item.role, item.org) || own;
    case "article":
      return join(siteOf(item), item.date) || str(item.author) || own;
    case "media":
      return join(siteOf(item), item.date) || str(item.author) || own;
    case "file":
      return own || str(item.lang);
    default:
      return own || str(item.note);
  }
}

// "650 m" stays; 650 → "650 m"; 1400 → "1.4 km".
export function formatDistance(d) {
  if (typeof d === "number" && Number.isFinite(d)) return d >= 1000 ? `${(d / 1000).toFixed(1).replace(/\.0$/, "")} km` : `${Math.round(d)} m`;
  return str(d);
}

// The fact chips of a card, in board order. `full` adds review counts and walk times (Hero).
export function Facts({ kind, item, full = false, className = "gv-facts" }) {
  if (!item || typeof item !== "object") return null;
  const parts = [];
  if (item.rating != null && item.rating !== "") parts.push(<RatingInline key="r" value={item.rating} count={full ? item.reviews : undefined} />);
  if (kind === "place") {
    if (typeof item.price === "number") parts.push(<PriceLevel key="p" level={item.price} currency={str(item.currency)} />);
    const dist = formatDistance(item.distance);
    if (dist) {
      const walk = full ? str(item.walk) : "";
      parts.push(
        <span key="d" className="gv-fact-dist">
          {full ? <Icon name="map-pin" size={13} stroke={2} /> : null}
          {walk ? `${dist} · ${walk}` : dist}
        </span>,
      );
    }
  } else if (kind === "product") {
    if (item.price != null && item.price !== "") parts.push(<span key="p" className="gv-fact-price">{formatAmount(item.price, str(item.currency))}</span>);
  } else if (kind === "event" && item.price != null && item.price !== "") {
    parts.push(<span key="p">{formatAmount(item.price, str(item.currency))}</span>);
  }
  if (!parts.length) return null;
  return <span className={className}>{parts}</span>;
}

export function EntityStatus({ kind, item, className }) {
  if (kind === "product") {
    if (item?.inStock === true) return <StatusLine state="ok" text="In stock" className={className} />;
    if (item?.inStock === false) return <StatusLine state="idle" text="Out of stock" className={className} />;
    return null;
  }
  const s = placeStatus(item);
  return s ? <StatusLine state={s.state} text={s.text} className={className} /> : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// {month, day} from an event's start: ISO dates, "18 Oct", "Oct 18".
export function eventDay(start) {
  const s = str(start);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const m = Number(iso[2]);
    if (m >= 1 && m <= 12) return { month: MONTHS[m - 1], day: String(Number(iso[3])) };
  }
  const dm = /(\d{1,2})\s+([\p{L}]{3,})/u.exec(s);
  if (dm) return { month: dm[2].slice(0, 3), day: dm[1] };
  const md = /([\p{L}]{3,})\.?\s+(\d{1,2})\b/u.exec(s);
  if (md) return { month: md[1].slice(0, 3), day: md[2] };
  return null;
}

export function looksLikePath(s) {
  return typeof s === "string" && /[/\\]/.test(s) && !/\s/.test(s.trim());
}
