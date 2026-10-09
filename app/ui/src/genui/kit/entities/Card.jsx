// <Card of pick variant kind meta badge actions/> — one entity from a collection.

import { ItemScope, useView } from "../../runtime/ViewContext.jsx";
import { splitIds } from "../../../../../../contracts/src/genui/attrs.ts";
import { oneOf } from "../content/text.jsx";
import { sameId } from "../content/util.js";
import { EntityCard } from "./cards.jsx";
import { HeroLayout } from "./Hero.jsx";

export function Card({ attrs = {} }) {
  const view = useView();
  const of = typeof attrs.of === "string" ? attrs.of : null;
  const item = of ? (view?.collection?.(of) ?? []).find((it) => sameId(it?.id, attrs.pick)) : null;
  if (!item) return view?.streaming ? <div className="gv-card gv-card-skeleton gv-shimmer" aria-hidden="true" /> : null;
  const variant = oneOf(attrs.variant, ["row", "compact", "hero"], "compact");
  const actions = splitIds(attrs.actions);
  const selectable = item.id != null && typeof view?.select === "function";
  return (
    <ItemScope item={item}>
      {variant === "hero" ? (
        <HeroLayout item={item} of={of} kind={attrs.kind} meta={attrs.meta} badge={attrs.badge != null ? view.template(String(attrs.badge), item) : ""} actions={actions} />
      ) : (
        <div className={variant === "compact" ? "gv-card-solo" : undefined}>
          <EntityCard
            item={item}
            kind={attrs.kind}
            variant={variant}
            meta={attrs.meta}
            badge={attrs.badge}
            actions={actions}
            selected={sameId(view?.selected?.(of), item.id)}
            onSelect={selectable ? () => view.select(of, item.id) : null}
          />
        </div>
      )}
    </ItemScope>
  );
}
