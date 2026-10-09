// The side-panel tab for one visual answer (`view:<id>`): rebuilt from the
// stored spec, so it survives a reload. It shares state and selection with the
// inline copy (one store per view id); its actions go to the conversation that
// presented it.

import { useMemo } from "react";
import { useUi } from "../../state/ui.jsx";
import { viewIdOf } from "../../lib/panelTabs.js";
import { TAB_ICONS } from "../../views/agents/panes/panelTabMeta.jsx";
import { GenuiHostContext } from "../runtime/host.jsx";
import { MISSING, retryViewRecord, useViewRecord, useViewRecordError } from "./viewRecords.js";
import { ViewSkeleton, ViewSurface } from "../ViewBlock.jsx";
import { AppFrame } from "../apps/AppFrame.jsx";

export function ViewPanel({ live, tabId }) {
  const ui = useUi();
  const viewId = viewIdOf(tabId);
  const record = useViewRecord(viewId);
  const loadError = useViewRecordError(viewId);
  const workerId = record && record !== MISSING ? record.workerId : null;
  const worker = workerId ? live?.workers?.find((w) => w.id === workerId) : null;
  const sendToAgent = live?.sendToAgent;
  const host = useMemo(() => ({
    workerId,
    cwd: worker?.cwd ?? null,
    send: (text, opts) => (sendToAgent && workerId ? sendToAgent(workerId, text, opts) : Promise.resolve({ ok: false, status: 404 })),
    superseded: new Map(),
    fixedBelow: new Set(),
  }), [workerId, worker?.cwd, sendToAgent]);

  if (record === MISSING) {
    return (
      <div className="empty-state gv-panel-empty">
        <span className="empty-state__icon">{TAB_ICONS.view}</span>
        <span className="empty-state__title">This view is no longer available</span>
        <button className="empty-state__action" onClick={() => ui.closeTab(tabId)}>Close tab</button>
      </div>
    );
  }
  if (!record && loadError) {
    return (
      <div className="empty-state gv-panel-empty">
        <span className="empty-state__icon">{TAB_ICONS.view}</span>
        <span className="empty-state__title">Couldn't load this view</span>
        <span className="empty-state__subtitle">{loadError}</span>
        <button className="empty-state__action" onClick={() => void retryViewRecord(viewId)}>Retry</button>
      </div>
    );
  }
  if (!record) return <div className="gv-panel"><ViewSkeleton note="Loading view…" /></div>;

  return (
    <GenuiHostContext.Provider value={host}>
      <div className="gv-panel">
        {record.kind === "app"
          ? (
            <AppFrame
              viewId={record.id}
              title={record.spec.title}
              html={record.spec.html}
              height={record.spec.height}
              summary={record.spec.summary}
              mode="panel"
              onSend={(text) => host.send(String(text), {
                queueWhenBusy: true,
                action: { viewId: record.id, actionId: "app", label: String(text).slice(0, 200), viewTitle: String(record.title ?? "").slice(0, 200) },
              })}
            />
          )
          : <ViewSurface viewId={record.id} spec={record.spec} ts={record.createdAt} workerId={record.workerId} variant="panel" />}
      </div>
    </GenuiHostContext.Provider>
  );
}
