// List: a row per item. Titles, meta and badges template the item; child
// elements repeat per item as the detail of a disclosure row (Code
// value="{trace}", FileRef path="{file}"), rendered inside the item's scope.

import { useId, useState } from "react";
import { ItemScope, useView } from "../../runtime/ViewContext.jsx";
import { Icon } from "../icons.jsx";
import { ActionRow } from "../content/ActionButton.jsx";
import { BadgeChip, oneOf } from "../content/text.jsx";
import { cls, isTone, itemName, photoSrcs, sameId, siteOf, toneClass, tpl } from "../content/util.js";
import { attrBool, splitIds } from "../../../../../../contracts/src/genui/attrs.ts";
import { FilterEmpty } from "../inputs/FilterEmpty.jsx";
import { elementChildren } from "../layout/layout.jsx";
import { Thumb } from "./cards.jsx";
import { defaultMeta, kindOf, looksLikePath } from "./entity.jsx";

function rowKey(item, i) {
  return item && (typeof item.id === "string" || typeof item.id === "number") ? `id:${item.id}` : `i:${i}`;
}

// What leads a row, and how wide it is (the detail indents to the title).
function leadOf(view, item, { numbered, tone, variant }) {
  if (numbered) return { kind: "num", width: 22 };
  if (variant !== "compact" && (photoSrcs(view, item).length || siteOf(item))) return { kind: "thumb", width: variant === "disclosure" ? 32 : 40 };
  if (tone) return { kind: "dot", width: 8 };
  return null;
}

function Lead({ view, item, lead, n }) {
  if (!lead) return null;
  if (lead.kind === "num") return <span className="gv-list-num">{n}</span>;
  if (lead.kind === "thumb") return <Thumb view={view} kind={kindOf(view, item)} item={item} size={lead.width} />;
  return <span className="gv-list-dot" aria-hidden="true" />;
}

export function List({ attrs = {}, children }) {
  const view = useView();
  const of = typeof attrs.of === "string" ? attrs.of : null;
  const items = of ? view?.collection?.(of, attrs) ?? [] : [];
  const variant = oneOf(attrs.variant, ["row", "compact", "disclosure"], "row");
  const tone = isTone(attrs.tone) ? attrs.tone.toLowerCase() : null;
  const numbered = attrBool(attrs.numbered);
  const actions = splitIds(attrs.actions);
  const detail = elementChildren(children);
  const disclosure = variant === "disclosure";
  const [open, setOpen] = useState(() => (disclosure && items.length ? new Set([rowKey(items[0], 0)]) : new Set()));
  const baseId = useId().replace(/:/g, "");
  if (!of) return null;
  if (!items.length) return <FilterEmpty of={of} />;
  const sel = view?.selected?.(of);
  const all = view?.allItems?.(of) ?? items;
  const numberOf = (item, i) => {
    const at = all.indexOf(item);
    return at >= 0 ? at + 1 : i + 1;
  };
  const toggle = (key) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <ul className={cls("gv-list", `gv-list-v-${variant}`, toneClass(tone), tone && "is-toned")}>
      {items.map((item, i) => {
        const key = rowKey(item, i);
        const kind = kindOf(view, item);
        const title = attrs.title !== undefined ? tpl(view, attrs.title, item) : itemName(item);
        const meta = attrs.meta !== undefined ? tpl(view, attrs.meta, item) : defaultMeta(kind, item);
        const badge = attrs.badge !== undefined ? tpl(view, attrs.badge, item) : "";
        const selected = sameId(sel, item?.id);
        const isOpen = disclosure && open.has(key);
        const detailId = `${baseId}-${i}`;
        const selectable = item?.id != null && typeof view?.select === "function";
        const onMain = disclosure ? () => toggle(key) : selectable ? () => view.select(of, item.id) : undefined;
        const Main = onMain ? "button" : "div";
        const lead = leadOf(view, item, { numbered, tone, variant });
        const mainProps = onMain
          ? {
              type: "button",
              onClick: onMain,
              ...(disclosure ? { "aria-expanded": isOpen, "aria-controls": isOpen ? detailId : undefined } : { "aria-pressed": selected }),
            }
          : {};
        return (
          <li
            key={key}
            className={cls("gv-list-item", selected && "is-selected", isOpen && "is-open")}
            style={lead && disclosure ? { "--gv-indent": `${10 + lead.width + 12}px` } : undefined}
          >
            <div className="gv-list-row">
              <Main className="gv-list-main" {...mainProps}>
                <Lead view={view} item={item} lead={lead} n={numberOf(item, i)} />
                <span className="gv-list-text">
                  <span className="gv-list-title">{title}</span>
                  {meta ? <span className={cls("gv-list-meta", looksLikePath(meta) && "is-mono")}>{meta}</span> : null}
                </span>
                {badge ? <BadgeChip text={badge} tone={tone} hashTone={!tone} className="gv-list-badge" /> : null}
                {disclosure ? <Icon name="chevron-right" size={14} stroke={2} className={cls("gv-chev", isOpen && "is-open")} /> : null}
              </Main>
              {!disclosure && actions.length ? <ActionRow ids={actions} item={item} size="sm" className="gv-list-actions" /> : null}
            </div>
            {isOpen ? (
              <div className="gv-list-detail" id={detailId}>
                <ItemScope item={item}>
                  {detail}
                  {actions.length ? <ActionRow ids={actions} item={item} size="sm" className="gv-list-detail-actions" /> : null}
                </ItemScope>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
