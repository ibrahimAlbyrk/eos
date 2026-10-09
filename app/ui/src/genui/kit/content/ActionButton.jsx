// A button for one of the view's declared actions. Primary actions are the tone
// fill, the rest small glass; the runtime decides what the kind does
// (send → reply chip, open → panel, copy, prefill, set).

import { Icon, hasIcon } from "../icons.jsx";
import { useItem, useSendFailure, useSendPending, useView } from "../../runtime/ViewContext.jsx";
import { itemRef } from "../../runtime/runtime.js";
import { notify } from "../../../lib/notify.js";
import { cls, tpl } from "./util.js";

function defaultIcon(action) {
  if (hasIcon(action.icon)) return action.icon;
  const href = typeof action.href === "string" ? action.href.trim() : "";
  if (action.kind === "open" && /^maps:/i.test(href)) return "navigation";
  if (action.kind === "copy") return "copy";
  return null;
}

export function ActionButton({ id, item: itemProp, size = "md", variant, className, onBefore }) {
  const view = useView();
  const scoped = useItem();
  const sending = useSendPending(view?.viewId ?? null);
  const failure = useSendFailure(view?.viewId ?? null);
  const item = itemProp ?? scoped ?? undefined;
  const action = id != null ? view?.actions?.[id] : null;
  if (!action || typeof action !== "object") return null;
  const primary = variant ? variant === "primary" : action.primary === true;
  const icon = defaultIcon(action);
  const label = tpl(view, action.label, item) || String(id);
  const pending = action.kind === "send" && sending;
  const failed = failure && failure.actionId === id && failure.ref === itemRef(item) ? failure.reason : "";
  const busy = Boolean(view?.streaming) || pending;
  return (
    <button
      type="button"
      className={cls("gv-btn", primary ? "gv-btn-primary" : "gv-btn-secondary", size === "sm" && "gv-btn-sm", className)}
      aria-disabled={busy || undefined}
      aria-busy={pending || undefined}
      data-action={id}
      onClick={async (e) => {
        e.stopPropagation();
        if (busy) return;
        onBefore?.();
        const r = await view?.runAction?.(id, item !== undefined ? { item } : {});
        // "busy" is the double-send guard doing its job, not a failure.
        if (r?.ok === false && r.reason && r.reason !== "busy" && action.kind === "send") {
          notify.error(`Couldn't send “${label}”: ${r.reason}`);
        }
      }}
      title={failed || undefined}
    >
      {icon ? <Icon name={icon} size={14} stroke={2} /> : null}
      <span aria-live="polite">{failed ? "Couldn't send — try again" : label}</span>
    </button>
  );
}

// A row of action buttons from an ids list ("book route menu").
export function ActionRow({ ids, item, size, className, max }) {
  const list = Array.isArray(ids) ? ids : [];
  const shown = max ? list.slice(0, max) : list;
  if (!shown.length) return null;
  return (
    <div className={cls("gv-actions", className)}>
      {shown.map((id) => <ActionButton key={id} id={id} item={item} size={size} />)}
    </div>
  );
}
