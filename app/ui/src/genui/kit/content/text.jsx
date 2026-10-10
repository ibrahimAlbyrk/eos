// Text · Heading · Badge · Callout · Quote — prose atoms. Children are inline
// markdown from the agent; attributes may template item fields.

import { Icon, hasIcon } from "../icons.jsx";
import { useItem, useView } from "../../runtime/ViewContext.jsx";
import { attrBool, attrNum } from "../../../../../../contracts/src/genui/attrs.ts";
import { monoTone } from "../monogram.js";
import { ActionButton } from "./ActionButton.jsx";
import { Markdown } from "./Markdown.jsx";
import { sourceName } from "./Sources.jsx";
import { cls, isTone, scopedText, textOf, toneClass, tpl } from "./util.js";

export function oneOf(v, values, fallback) {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return values.includes(s) ? s : fallback;
}

// **bold**, `code` and [links](…) reduced to their text, for one-line labels.
export function plainInline(text) {
  return String(text ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

export function Text({ attrs = {}, node, children }) {
  const view = useView();
  const item = useItem();
  const text = scopedText(view, textOf(node, children), item);
  if (!text.trim()) return null;
  const muted = attrBool(attrs.muted);
  const size = oneOf(attrs.size, ["sm", "md", "lg"], muted ? "sm" : "md");
  return (
    <Markdown
      text={text}
      className={cls("gv-text", `gv-text-${size}`, muted && "is-muted", isTone(attrs.tone) && "is-toned", toneClass(attrs.tone))}
    />
  );
}

const HEADING_TAG = { 1: "h3", 2: "h4", 3: "h5" };

export function Heading({ attrs = {}, node, children }) {
  const view = useView();
  const item = useItem();
  const text = plainInline(scopedText(view, textOf(node, children), item));
  if (!text) return null;
  const level = Math.min(3, Math.max(1, Math.round(attrNum(attrs.level) ?? 1)));
  const Tag = HEADING_TAG[level];
  const meta = tpl(view, attrs.meta, item);
  const icon = hasIcon(attrs.icon) ? attrs.icon : null;
  return (
    <div className={cls("gv-heading", `gv-heading-${level}`)}>
      {icon ? <span className="gv-heading-icon"><Icon name={icon} size={level === 1 ? 16 : 14} /></span> : null}
      <Tag className="gv-heading-text">{text}</Tag>
      {meta ? <span className="gv-heading-meta">{meta}</span> : null}
    </div>
  );
}

// A small tag. No tone → neutral; `hashTone` gives untoned labels a stable
// tone from their text (List badges: "socket", "timeout" each keep a color).
export function BadgeChip({ text, tone, icon, variant = "soft", hashTone = false, onImage = false, className }) {
  if (!text) return null;
  const t = isTone(tone) ? tone.toLowerCase() : hashTone ? monoTone(text) : null;
  return (
    <span className={cls("gv-badge", `gv-badge-${variant}`, onImage && "is-on-image", t ? `gv-tone-${t} is-toned` : "is-neutral", className)}>
      {hasIcon(icon) ? <Icon name={icon} size={12} stroke={2} /> : null}
      <span>{text}</span>
    </span>
  );
}

export function Badge({ attrs = {}, node, children }) {
  const view = useView();
  const item = useItem();
  const text = plainInline(scopedText(view, textOf(node, children), item));
  const variant = oneOf(attrs.variant, ["soft", "solid", "outline"], "soft");
  return <BadgeChip text={text} tone={tpl(view, attrs.tone, item)} icon={attrs.icon} variant={variant} />;
}

const CALLOUT_ICON = { info: "info", tip: "lightbulb", warning: "alert-triangle", danger: "alert-octagon", success: "check-circle" };
const CALLOUT_TONE = { warning: "amber", danger: "red", success: "green" };

export function Callout({ attrs = {}, node, children }) {
  const view = useView();
  const item = useItem();
  const kind = oneOf(attrs.kind, ["info", "tip", "warning", "danger", "success"], "info");
  const title = tpl(view, attrs.title, item);
  const text = scopedText(view, textOf(node, children), item);
  const icon = hasIcon(attrs.icon) ? attrs.icon : CALLOUT_ICON[kind];
  const action = typeof attrs.action === "string" ? attrs.action : null;
  const tone = CALLOUT_TONE[kind];
  return (
    <div className={cls("gv-callout", `gv-callout-${kind}`, tone && `gv-tone-${tone}`)} role="note">
      <span className="gv-callout-icon"><Icon name={icon} size={kind === "tip" ? 16 : 18} /></span>
      <div className="gv-callout-body">
        {title ? <div className="gv-callout-title">{title}</div> : null}
        {text.trim() ? <Markdown text={text} className="gv-callout-text" /> : null}
      </div>
      {action ? <ActionButton id={action} item={item ?? undefined} size="sm" className="gv-callout-action" /> : null}
    </div>
  );
}

export function Quote({ attrs = {}, node, children }) {
  const view = useView();
  const item = useItem();
  const text = scopedText(view, textOf(node, children), item);
  if (!text.trim()) return null;
  const cite = tpl(view, attrs.cite, item);
  const src = attrNum(attrs.source);
  const srcName = src != null ? sourceName(view, src) : null;
  return (
    <figure className="gv-quote">
      <blockquote className="gv-quote-text"><Markdown text={text} /></blockquote>
      {cite || srcName ? (
        <figcaption className="gv-quote-cite">
          {cite ? <span>— {cite}</span> : null}
          {srcName ? <span className="gv-dim">{cite ? " · " : "— "}{srcName}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
