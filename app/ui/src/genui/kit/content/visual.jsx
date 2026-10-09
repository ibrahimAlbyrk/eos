// Image · Gallery · Logo. Every source goes through the view's media proxy and
// every failure ends on a monogram — never a broken image.

import { useItem, useView } from "../../runtime/ViewContext.jsx";
import { attrText, splitIds } from "../../../../../../contracts/src/genui/attrs.ts";
import { MediaImg, MonoTile, Monogram } from "./media.jsx";
import { oneOf } from "./text.jsx";
import { cls, hostOf, itemName, logoSrcs, sameId, tpl } from "./util.js";

function proxied(view, url) {
  const fn = view?.media?.img;
  return typeof fn === "function" && typeof url === "string" && url ? fn(url) || null : null;
}

const RATIOS = ["16:9", "4:3", "3:2", "1:1", "21:9"];

export function Image({ attrs = {} }) {
  const view = useView();
  const item = useItem();
  const src = tpl(view, attrs.src, item);
  const alt = tpl(view, attrs.alt, item);
  const credit = tpl(view, attrs.credit, item);
  const ratio = oneOf(attrs.ratio, RATIOS, "16:9");
  const fit = oneOf(attrs.fit, ["cover", "contain"], "cover");
  const name = alt || hostOf(src) || "?";
  return (
    <figure className="gv-image" style={{ "--gv-ratio": ratio.replace(":", " / ") }}>
      <MediaImg srcs={[proxied(view, src)]} alt={alt} fit={fit} className="gv-fill" fallback={<MonoTile name={name} className="gv-fill" />} />
      {credit ? <figcaption className="gv-image-credit">{/^©/.test(credit) ? credit : `© ${credit}`}</figcaption> : null}
    </figure>
  );
}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

// Own-property dotted lookup ("photos.main").
function getPath(obj, path) {
  let cur = obj;
  for (const k of String(path).split(".")) {
    if (FORBIDDEN.has(k) || cur == null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

// [{src, name, item}] from images= or from a collection's image field(s).
function galleryEntries(view, attrs) {
  if (Array.isArray(attrs.images)) {
    return attrs.images.filter((u) => typeof u === "string").map((u) => ({ src: u, name: hostOf(u) || "image" }));
  }
  const of = typeof attrs.of === "string" ? attrs.of : null;
  if (!of) return [];
  const items = view?.collection?.(of, attrs) ?? [];
  const named = splitIds(attrText(attrs.field));
  const fields = named.length ? named : ["image", "images"];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    for (const f of fields) {
      const v = getPath(it, f);
      for (const u of Array.isArray(v) ? v : [v]) {
        if (typeof u !== "string" || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
        seen.add(u);
        out.push({ src: u, name: itemName(it), item: it });
      }
    }
  }
  return out;
}

const GALLERY_SHOWN = { bento: 3, grid: 4, strip: 5 };

export function GalleryTiles({ entries, layout = "bento", onPick, selectedId, label }) {
  const view = useView();
  if (!entries.length) return null;
  const max = GALLERY_SHOWN[layout] ?? 3;
  const shown = entries.slice(0, max);
  const more = entries.length - shown.length;
  const kind = layout === "bento" && shown.length === 1 ? "single" : layout === "bento" && shown.length === 2 ? "pair" : layout;
  return (
    <div className={cls("gv-gallery", `gv-gallery-${kind}`)} role="group" aria-label={label || `${entries.length} images`}>
      {shown.map((e, i) => {
        const last = i === shown.length - 1 && more > 0;
        const tile = (
          <>
            <MediaImg srcs={[proxied(view, e.src)]} alt={e.name} className="gv-fill" fallback={<MonoTile name={e.name} initials={i === 0 && !last} className="gv-fill" />} />
            {last ? <span className="gv-gallery-more" aria-label={`${more} more`}>+{more}</span> : null}
          </>
        );
        const sel = e.item && sameId(selectedId, e.item.id);
        return onPick && e.item ? (
          <button type="button" key={i} className={cls("gv-gallery-tile", sel && "is-selected")} aria-pressed={sel} aria-label={e.name} onClick={() => onPick(e)}>
            {tile}
          </button>
        ) : (
          <span key={i} className="gv-gallery-tile">{tile}</span>
        );
      })}
    </div>
  );
}

export function Gallery({ attrs = {} }) {
  const view = useView();
  const entries = galleryEntries(view, attrs);
  const layout = oneOf(attrs.layout, ["bento", "grid", "strip"], "bento");
  const of = typeof attrs.of === "string" ? attrs.of : null;
  return (
    <GalleryTiles
      entries={entries}
      layout={layout}
      selectedId={of ? view?.selected?.(of) : null}
      onPick={of && view?.select ? (e) => view.select(of, e.item.id) : null}
    />
  );
}

const LOGO_SIZE = { sm: 20, md: 32, lg: 44 };

// A brand mark: logo.dev → the site's icon → monogram.
export function LogoMark({ view, site, name, size = 32, round = false, className }) {
  const label = name || site || "";
  return (
    <span className={cls("gv-logo", round && "is-round", className)} style={{ "--gv-logo-size": `${size}px` }} title={label || undefined}>
      <MediaImg
        srcs={logoSrcs(view, site)}
        alt={label ? `${label} logo` : ""}
        fit="contain"
        className="gv-fill gv-logo-img"
        fallback={<Monogram name={name || site || "?"} size={size} round={round} className="gv-fill" label={label || undefined} />}
      />
    </span>
  );
}

export function Logo({ attrs = {} }) {
  const view = useView();
  const item = useItem();
  const site = hostOf(tpl(view, attrs.site, item)) || tpl(view, attrs.site, item);
  const name = tpl(view, attrs.name, item);
  if (!site && !name) return null;
  const size = LOGO_SIZE[oneOf(attrs.size, ["sm", "md", "lg"], "md")];
  return <LogoMark view={view} site={site} name={name} size={size} />;
}
