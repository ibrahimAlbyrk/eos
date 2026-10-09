// Hero: the top pick, large — gallery, brand, facts, the agent's reason and the
// actions. Card variant="hero" uses the same layout without a reason.

import { ItemScope, useView } from "../../runtime/ViewContext.jsx";
import { Icon } from "../icons.jsx";
import { ActionButton } from "../content/ActionButton.jsx";
import { MediaImg, MonoTile } from "../content/media.jsx";
import { Markdown } from "../content/Markdown.jsx";
import { GalleryTiles, LogoMark } from "../content/visual.jsx";
import { cls, itemName, openHref, photoSrcs, sameId, siteOf, textOf, tpl } from "../content/util.js";
import { attrBool, splitIds } from "../../../../../../contracts/src/genui/attrs.ts";
import { EntityStatus, Facts, defaultMeta, kindOf } from "./entity.jsx";

function HeroMedia({ view, item, badge, gallery, onSelect, selected }) {
  const name = itemName(item);
  const imgs = [];
  if (typeof item.image === "string") imgs.push(item.image);
  if (Array.isArray(item.images)) for (const u of item.images) if (typeof u === "string" && !imgs.includes(u)) imgs.push(u);
  const useGallery = imgs.length >= 3 || (gallery && imgs.length >= 2);
  const inner = useGallery ? (
    <GalleryTiles entries={imgs.map((src) => ({ src, name }))} layout="bento" label={`${name} photos`} />
  ) : (
    <MediaImg srcs={photoSrcs(view, item)} alt="" className="gv-fill" fallback={<MonoTile name={name} className="gv-fill" />} />
  );
  return (
    <div className="gv-hero-media">
      {inner}
      {onSelect ? (
        <button type="button" className="gv-hero-hit" aria-label={`Select ${name}`} aria-pressed={selected} onClick={onSelect} />
      ) : null}
      {badge ? (
        <span className="gv-hero-badge">
          <Icon name="star-solid" size={12} className="gv-hero-badge-star" />
          {badge}
        </span>
      ) : null}
    </div>
  );
}

// Action ids already cover the website when one of them opens {url}.
function opensUrl(view, ids) {
  return ids.some((id) => {
    const a = view?.actions?.[id];
    return a && a.kind === "open" && typeof a.href === "string" && /^\{\s*(item\.)?url\s*\}$/.test(a.href.trim());
  });
}

export function HeroLayout({ item, of, badge, meta: metaAttr, actions = [], gallery = false, reason = "", kind: kindAttr }) {
  const view = useView();
  const kind = kindOf(view, item, kindAttr);
  const name = itemName(item);
  const meta = metaAttr != null ? tpl(view, metaAttr, item) : defaultMeta(kind, item);
  const selected = of ? sameId(view?.selected?.(of), item.id) : false;
  const onSelect = of && item.id != null && view?.select ? () => view.select(of, item.id) : null;
  const site = siteOf(item);
  const url = typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : null;
  return (
    <div className="gv-hero-wrap">
      <article className={cls("gv-hero", selected && "is-selected")}>
        <HeroMedia view={view} item={item} badge={badge} gallery={gallery} onSelect={onSelect} selected={selected} />
        <div className="gv-hero-body">
          <div className="gv-hero-head">
            <LogoMark view={view} site={site} name={name} size={40} round className="gv-hero-logo" />
            <div className="gv-hero-names">
              <div className="gv-hero-name">{name}</div>
              {meta ? <div className="gv-hero-meta">{meta}</div> : null}
            </div>
          </div>
          <div className="gv-hero-facts">
            <Facts kind={kind} item={item} full className="gv-facts is-hero" />
            <EntityStatus kind={kind} item={item} />
          </div>
          {kind === "article" && typeof item.excerpt === "string" && !reason ? <div className="gv-hero-excerpt">{item.excerpt}</div> : null}
          {reason ? (
            <div className="gv-hero-why">
              <span className="gv-hero-why-lead">Why this · </span>
              <Markdown text={reason} className="is-inline" />
            </div>
          ) : null}
          <div className="gv-hero-actions">
            {actions.map((id) => <ActionButton key={id} id={id} item={item} />)}
            {url && !opensUrl(view, actions) ? (
              <a
                className="gv-iconbtn"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open website"
                title="Open website"
                onClick={(e) => {
                  if (openHref(view, url)) e.preventDefault();
                }}
              >
                <Icon name="external" size={14} stroke={2} />
              </a>
            ) : null}
            {onSelect && Array.isArray(item.geo) ? (
              <button type="button" className="gv-iconbtn" aria-label="Show on map" title="Show on map" aria-pressed={selected} onClick={onSelect}>
                <Icon name="map-pin" size={14} stroke={2} />
              </button>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}

export function Hero({ attrs = {}, node, children }) {
  const view = useView();
  const of = typeof attrs.of === "string" ? attrs.of : null;
  const pick = attrs.pick;
  // The picked item as the lenses see it: hidden while the Filters chips exclude it.
  const visible = of ? view?.collection?.(of) ?? [] : [];
  const item = visible.find((it) => sameId(it?.id, pick));
  if (!item) {
    const exists = of && (view?.allItems?.(of) ?? []).some((it) => sameId(it?.id, pick));
    return view?.streaming && !exists ? <div className="gv-hero-wrap"><div className="gv-hero gv-hero-skeleton gv-shimmer" aria-hidden="true" /></div> : null;
  }
  return (
    <ItemScope item={item}>
      <HeroLayout
        item={item}
        of={of}
        badge={tpl(view, attrs.badge, item)}
        meta={attrs.meta}
        actions={splitIds(attrs.actions)}
        gallery={attrBool(attrs.gallery)}
        reason={textOf(node, children).trim()}
      />
    </ItemScope>
  );
}
