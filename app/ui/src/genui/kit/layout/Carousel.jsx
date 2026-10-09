// Carousel: 3–8 cards scrolling sideways — scroll-snap, the next card peeking
// at the edge, prev/next buttons (in the enclosing Section's header when there
// is one) and arrow keys between cards. Cards select their entity on click.

import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { ItemScope, useView } from "../../runtime/ViewContext.jsx";
import { Icon } from "../icons.jsx";
import { matchWhere } from "../../../../../../contracts/src/genui/expr.ts";
import { splitIds } from "../../../../../../contracts/src/genui/attrs.ts";
import { oneOf } from "../content/text.jsx";
import { cls, sameId } from "../content/util.js";
import { EntityCard } from "../entities/cards.jsx";
import { HeroLayout } from "../entities/Hero.jsx";
import { FilterEmpty } from "../inputs/FilterEmpty.jsx";
import { SectionContext, elementChildren } from "./layout.jsx";

function reducedMotion() {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

function Arrows({ prev, next, onPage, overlay = false }) {
  return (
    <>
      <button
        type="button"
        className={cls("gv-iconbtn", "gv-carousel-arrow", overlay && "is-overlay is-prev")}
        aria-label="Previous"
        disabled={!prev}
        hidden={overlay && !prev}
        onClick={() => onPage(-1)}
      >
        <Icon name="chevron-left" size={14} stroke={2} />
      </button>
      <button
        type="button"
        className={cls("gv-iconbtn", "gv-carousel-arrow", overlay && "is-overlay is-next")}
        aria-label="Next"
        disabled={!next}
        hidden={overlay && !next}
        onClick={() => onPage(1)}
      >
        <Icon name="chevron-right" size={14} stroke={2} />
      </button>
    </>
  );
}

export function Carousel({ attrs = {}, children }) {
  const view = useView();
  const of = typeof attrs.of === "string" ? attrs.of : null;
  const variant = oneOf(attrs.card, ["row", "compact", "hero"], "compact");
  const actions = splitIds(attrs.actions);
  const items = of ? view?.collection?.(of, attrs) ?? [] : [];
  const kids = of ? [] : elementChildren(children);
  const count = of ? items.length : kids.length;

  const trackRef = useRef(null);
  const [edges, setEdges] = useState({ prev: false, next: count > 1 });
  const [claimed, setClaimed] = useState(false);
  const section = useContext(SectionContext);
  const token = useId();

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { prev: el.scrollLeft > 2, next: el.scrollLeft < max - 2 };
    setEdges((cur) => (cur.prev === next.prev && cur.next === next.next ? cur : next));
  }, []);

  useEffect(() => {
    measure();
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, count]);

  const page = useCallback((dir) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.8), behavior: reducedMotion() ? "auto" : "smooth" });
  }, []);

  // Inside a Section the count and the arrows go to its header; the first
  // carousel of a section claims it.
  useEffect(() => {
    if (!section) return;
    if (section.owner.current && section.owner.current !== token) return;
    section.owner.current = token;
    setClaimed(true);
    section.setExtra({ count, controls: count > 1 ? <Arrows prev={edges.prev} next={edges.next} onPage={page} /> : null });
  }, [section, token, count, edges.prev, edges.next, page]);
  useEffect(
    () => () => {
      if (section && section.owner.current === token) {
        section.owner.current = null;
        section.setExtra(null);
      }
    },
    [section, token],
  );

  const onKey = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const track = trackRef.current;
    if (!track) return;
    const slides = [...track.querySelectorAll(":scope > .gv-carousel-slide")];
    const at = slides.findIndex((s) => s.contains(document.activeElement));
    if (at < 0) return;
    const to = slides[at + (e.key === "ArrowRight" ? 1 : -1)];
    const target = to?.querySelector("button, a[href], [tabindex]:not([tabindex='-1'])");
    if (!target) return;
    e.preventDefault();
    target.focus({ preventScroll: true });
    to.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  };

  if (of && !items.length) return <FilterEmpty of={of} compact />;
  if (!count) return null;

  let slides;
  if (of) {
    const sel = view?.selected?.(of);
    const where = typeof attrs.where === "string" ? attrs.where : "";
    const numbered = (view?.allItems?.(of) ?? []).filter((it) => !where || matchWhere(it, where, view?.state));
    slides = items.map((it, i) => {
      const n = Array.isArray(it?.geo) ? numbered.indexOf(it) + 1 || null : null;
      const selectable = it?.id != null && typeof view?.select === "function";
      return (
        <ItemScope key={it?.id ?? i} item={it}>
          {variant === "hero" ? (
            <HeroLayout item={it} of={of} meta={attrs.meta} actions={actions} />
          ) : (
            <EntityCard
              item={it}
              variant={variant}
              meta={attrs.meta}
              actions={actions}
              n={n}
              selected={sameId(sel, it?.id)}
              onSelect={selectable ? () => view.select(of, it.id) : null}
            />
          )}
        </ItemScope>
      );
    });
  } else {
    slides = kids;
  }

  return (
    <div
      className={cls("gv-carousel", `gv-carousel-${variant}`, edges.prev && "can-prev", edges.next && "can-next")}
      role="region"
      aria-roledescription="carousel"
      aria-label={`${count} items`}
    >
      <div className="gv-carousel-track" ref={trackRef} onScroll={measure} onKeyDown={onKey}>
        {slides.map((s, i) => (
          <div className="gv-carousel-slide" role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${count}`} key={s?.key ?? i}>
            {s}
          </div>
        ))}
      </div>
      {!claimed && count > 1 ? <Arrows prev={edges.prev} next={edges.next} onPage={page} overlay /> : null}
    </div>
  );
}
