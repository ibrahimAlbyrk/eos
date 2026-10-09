// The kit's one hook: useView() returns
//   { viewId, tone, data, actions, streaming, collection(name, lens?), allItems(name),
//     selected(name), select(name, id), filters(name), toggleFilter(name, chipIndex), clearFilters(name),
//     state, getState(key, fallback), setState(key, value), runAction(actionId, { item }),
//     media: { img(url), og(pageUrl), icon(site), logo(site) }, template(str, item),
//     evalExpr(expr), entityKind(item), item, formatNumber }
// `collection(name)` is the collection with the Filters chips applied; pass the
// element's attrs as `lens` to also apply its where= / skip= / sort= / limit=.
// Inside <ItemScope item> (a List row, a Carousel card) template() and
// evalExpr() default to that item and runAction() carries it.

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { bindItem, createViewRuntime, isSendPending, scanMarkup, sendFailure, subscribeSendPending } from "./runtime.js";
import { getViewState, setSelection, setViewState, useViewSelection, useViewState } from "./viewStateStore.js";
import { getGenuiSettings, subscribeGenuiSettings } from "./genuiSettings.js";
import { mediaFor } from "./media.js";

const logoKeySnap = () => getGenuiSettings().logoDevKey ?? null;

const ViewCtx = createContext(null);
const ItemCtx = createContext(undefined);

const FALLBACK = createViewRuntime({ viewId: null, spec: {} });

export function ViewProvider({ viewId, viewTitle, spec, nodes, streaming = false, host, children }) {
  const [state] = useViewState(viewId);
  const selection = useViewSelection(viewId);
  const scan = useMemo(() => scanMarkup(nodes), [nodes]);
  // The logo.dev key can arrive after the view rendered (boot GET, Settings).
  const logoKey = useSyncExternalStore(subscribeGenuiSettings, logoKeySnap, logoKeySnap);
  const media = useMemo(() => mediaFor(logoKey), [logoKey]);
  const runtime = useMemo(
    () => createViewRuntime({
      viewId,
      viewTitle: viewTitle ?? spec?.title ?? "",
      spec,
      scan,
      state,
      selection,
      setState: (key, value) => setViewState(viewId, key, value),
      liveState: () => getViewState(viewId),
      select: (name, id) => setSelection(viewId, name, id),
      host,
      streaming,
      media,
    }),
    [viewId, viewTitle, spec, scan, state, selection, host, streaming, media],
  );
  return <ViewCtx.Provider value={runtime}>{children}</ViewCtx.Provider>;
}

export function ItemScope({ item, children }) {
  return <ItemCtx.Provider value={item}>{children}</ItemCtx.Provider>;
}

export function useItem() {
  return useContext(ItemCtx);
}

// True while this view's send action is on its way (and for a beat after), so
// a button can show it is busy instead of looking dead.
export function useSendPending(viewId) {
  const snap = useCallback(() => isSendPending(viewId), [viewId]);
  return useSyncExternalStore(subscribeSendPending, snap, snap);
}

// The view's last failed send ({ actionId, ref, reason }) for a few seconds, else null.
export function useSendFailure(viewId) {
  const snap = useCallback(() => sendFailure(viewId), [viewId]);
  return useSyncExternalStore(subscribeSendPending, snap, snap);
}

export function useView() {
  const rt = useContext(ViewCtx) ?? FALLBACK;
  const item = useContext(ItemCtx);
  return useMemo(() => bindItem(rt, item), [rt, item]);
}
