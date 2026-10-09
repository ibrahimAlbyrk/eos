// Card: one entity in one of three densities — row (dense lists), compact
// (carousels, grids) and hero. Clicking a card selects its entity in the
// collection, so the pin, the table row and the card highlight together.

import { useView } from "../../runtime/ViewContext.jsx";
import { Icon } from "../icons.jsx";
import { ActionRow } from "../content/ActionButton.jsx";
import { MediaImg, MonoTile, Monogram } from "../content/media.jsx";
import { BadgeChip } from "../content/text.jsx";
import { LogoMark } from "../content/visual.jsx";
import { cls, formatAmount, itemName, photoSrcs, sameId, siteOf, tpl } from "../content/util.js";
import { EntityStatus, Facts, defaultMeta, eventDay, formatDistance, kindOf, looksLikePath } from "./entity.jsx";

const PLAYABLE = new Set(["video", "audio", "podcast"]);

// A calendar leaf: month bar in the tone, day below.
export function DateLeaf({ start }) {
  const d = eventDay(start);
  return (
    <span className="gv-dateleaf" aria-hidden="true">
      {d ? (
        <>
          <span className="gv-dateleaf-month">{d.month.toUpperCase()}</span>
          <span className="gv-dateleaf-day">{d.day}</span>
        </>
      ) : (
        <span className="gv-dateleaf-icon"><Icon name="calendar" size={18} /></span>
      )}
    </span>
  );
}

// The square on the left of a row card.
export function Thumb({ view, kind, item, size = 56 }) {
  const name = itemName(item);
  const style = { "--gv-thumb": `${size}px` };
  if (kind === "person") {
    const srcs = photoSrcs(view, item, { all: true });
    return (
      <span className="gv-thumb is-round" style={style}>
        <MediaImg srcs={srcs} alt="" className="gv-fill" fallback={<Monogram name={name} size={size} round className="gv-fill" />} />
      </span>
    );
  }
  if (kind === "event") return <span className="gv-thumb is-leaf" style={style}><DateLeaf start={item.start} /></span>;
  if (kind === "file") {
    return (
      <span className="gv-thumb is-icon" style={style}>
        <Icon name="file" size={Math.round(size * 0.4)} />
      </span>
    );
  }
  const srcs = photoSrcs(view, item);
  const site = siteOf(item);
  const fallback = srcs.length || !site
    ? <MonoTile name={name} className="gv-fill" />
    : <LogoMark view={view} site={site} name={name} size={size} className="gv-fill" />;
  return (
    <span className="gv-thumb" style={style}>
      <MediaImg srcs={srcs} alt="" className="gv-fill" fit={kind === "product" ? "contain" : "cover"} fallback={fallback} />
    </span>
  );
}

function trailingOf(kind, item) {
  if (kind === "place") return formatDistance(item.distance);
  if (kind === "product" && item.price != null && item.price !== "") return formatAmount(item.price, typeof item.currency === "string" ? item.currency : "");
  if (kind === "media" && typeof item.duration === "string") return item.duration;
  return "";
}

function FileStat({ item }) {
  const add = Number(item.added);
  const del = Number(item.removed);
  if (!Number.isFinite(add) && !Number.isFinite(del)) return null;
  return (
    <span className="gv-filestat">
      {Number.isFinite(add) ? <span className="gv-add">+{add}</span> : null}
      {Number.isFinite(del) ? <span className="gv-del">−{del}</span> : null}
    </span>
  );
}

// The photo area of a compact card.
function CardMedia({ view, kind, item, n, badge }) {
  const name = itemName(item);
  const srcs = photoSrcs(view, item);
  const place = kind === "place";
  return (
    <span className={cls("gv-card-media", kind === "product" && "is-product")}>
      <MediaImg
        srcs={srcs}
        alt=""
        className="gv-fill"
        fit={kind === "product" ? "contain" : "cover"}
        fallback={<MonoTile name={name} initials={!place && !PLAYABLE.has(String(item.kind))} className="gv-fill" />}
      />
      {PLAYABLE.has(String(item.kind)) ? (
        <span className="gv-card-play" aria-hidden="true"><Icon name="play" size={14} /></span>
      ) : null}
      {kind === "media" && typeof item.duration === "string" ? <span className="gv-card-duration">{item.duration}</span> : null}
      {n != null ? <span className="gv-card-num" aria-hidden="true">{n}</span> : null}
      {badge ? <BadgeChip text={badge} onImage className="gv-card-badge" /> : null}
      {place ? <LogoMark view={view} site={siteOf(item)} name={name} size={34} round className="gv-card-logo" /> : null}
    </span>
  );
}

const MEDIA_KINDS = new Set(["place", "product", "article", "media"]);

// One entity as a card. `onSelect` null → not selectable (no collection).
export function EntityCard({ item, kind: kindAttr, variant = "compact", meta: metaAttr, badge: badgeAttr, actions = [], n = null, selected = false, onSelect = null }) {
  const view = useView();
  if (!item || typeof item !== "object") return null;
  const kind = kindOf(view, item, kindAttr);
  const name = itemName(item);
  const meta = metaAttr != null ? tpl(view, metaAttr, item) : defaultMeta(kind, item);
  const badge = badgeAttr != null ? tpl(view, badgeAttr, item) : "";
  const hasMedia = MEDIA_KINDS.has(kind);
  const layout = variant === "row" ? "row" : hasMedia ? "compact" : "tile";
  const hitProps = onSelect
    ? { type: "button", onClick: onSelect, "aria-pressed": selected }
    : {};
  const Hit = onSelect ? "button" : "div";

  let body;
  if (layout === "row") {
    const trail = trailingOf(kind, item);
    body = (
      <Hit className="gv-card-hit gv-card-rowgrid" {...hitProps}>
        <Thumb view={view} kind={kind} item={item} />
        <span className="gv-card-text">
          <span className="gv-card-title">{name}</span>
          <span className={cls("gv-card-meta", looksLikePath(meta) && "is-mono")}>
            {meta ? <span>{meta}</span> : null}
            {kind === "place" ? <Facts kind={kind} item={{ ...item, distance: undefined }} className="gv-facts is-inline" /> : null}
          </span>
          {badge ? <BadgeChip text={badge} hashTone /> : null}
        </span>
        {kind === "file" ? <FileStat item={item} /> : trail ? <span className="gv-card-trail">{trail}</span> : null}
      </Hit>
    );
  } else if (layout === "compact") {
    body = (
      <Hit className="gv-card-hit" {...hitProps}>
        <CardMedia view={view} kind={kind} item={item} n={n} badge={badge} />
        <span className={cls("gv-card-body", kind === "place" && "has-logo")}>
          <span className="gv-card-title">{name}</span>
          {meta ? <span className="gv-card-meta">{meta}</span> : null}
          {kind === "article" && typeof item.excerpt === "string" ? <span className="gv-card-excerpt">{item.excerpt}</span> : null}
          {kind === "product" ? (
            <span className="gv-card-pricerow">
              <Facts kind={kind} item={item} />
              <EntityStatus kind={kind} item={item} className="gv-card-status" />
            </span>
          ) : (
            <>
              <Facts kind={kind} item={item} />
              <EntityStatus kind={kind} item={item} className="gv-card-status" />
            </>
          )}
        </span>
      </Hit>
    );
  } else {
    body = (
      <Hit className="gv-card-hit gv-card-tilegrid" {...hitProps}>
        <Thumb view={view} kind={kind} item={item} size={kind === "person" ? 40 : 46} />
        <span className="gv-card-text">
          <span className={cls("gv-card-title", kind === "file" && "is-mono")}>{kind === "file" ? item.path ?? name : name}</span>
          {kind === "file" ? (
            <span className="gv-card-meta">
              <FileStat item={item} />
              {meta ? <span>{meta}</span> : null}
            </span>
          ) : meta ? <span className="gv-card-meta">{meta}</span> : null}
          {badge ? <BadgeChip text={badge} hashTone /> : null}
        </span>
      </Hit>
    );
  }
  return (
    <article className={cls("gv-card", `gv-card-${layout}`, `gv-kind-${kind}`, selected && "is-selected", onSelect && "is-selectable")}>
      {body}
      {actions.length ? <ActionRow ids={actions} item={item} size="sm" className="gv-card-actions" /> : null}
    </article>
  );
}

export function useSelection(view, of) {
  const sel = of ? view?.selected?.(of) : null;
  return {
    isSelected: (item) => sameId(sel, item?.id),
    select: (item) => (of && item?.id != null && view?.select ? () => view.select(of, item.id) : null),
  };
}
