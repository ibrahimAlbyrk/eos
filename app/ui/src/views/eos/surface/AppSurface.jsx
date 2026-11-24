import { useEffect, useRef, useState } from "react";
import { notify } from "../../../lib/notify.js";
import { refreshInbox } from "../../../state/eos/inboxStore.js";
import { loadPage, loadVersion, usePages, versionKey } from "../../../state/eos/pageStore.js";
import { ensurePinsLoaded } from "../../../state/eos/pinsStore.js";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { callSurfaceApp, pressId, promoteApp } from "../../../state/eos/surfacesStore.js";
import { useSettingOr } from "../../../state/settings.jsx";
import { AppFrame } from "../../../genui/apps/AppFrame.jsx";
import { Loading, LoadFailed } from "../capabilities/parts.jsx";
import { ConfirmBelow } from "../needs/SurfaceCard.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { PinButton } from "./PinButton.jsx";

const isAction = (name) => !name.startsWith("query.") && !name.startsWith("state.") && !name.startsWith("files.");

// An App's calls, relayed to the core. An action the gate wants confirmed is
// asked in Eos's own strip below the frame, never inside it; the App waits
// for the answer.
function useAppCalls(surfaceId, version) {
  const [asking, setAsking] = useState(null);
  const [typed, setTyped] = useState("");
  const pending = useRef(null);
  const settle = (answer, call) => {
    if (!isAction(call.name) || answer?.status === "done") return answer?.status === "done" ? answer.result ?? null : answer;
    if (answer?.status === "confirm") {
      return new Promise((resolve, reject) => {
        pending.current = { call, answer, resolve, reject };
        setTyped("");
        setAsking({ prompt: answer.prompt, typeToConfirm: answer.typeToConfirm });
      });
    }
    if (answer?.status === "held") {
      notify.info("It waits in Needs you for you to send.");
      void refreshInbox();
      throw new Error("It waits in Needs you.");
    }
    throw new Error(answer?.reason ?? "That did not run.");
  };
  const onCall = async (name, args) => {
    const call = { surfaceId, version, name, arguments: args, ...(isAction(name) ? { clientId: pressId() } : {}) };
    return settle(await callSurfaceApp(call), call);
  };
  const answer = async (yes) => {
    const open = pending.current;
    pending.current = null;
    setAsking(null);
    if (!open) return;
    if (!yes) { open.reject(new Error("The user said no.")); return; }
    try {
      const repeat = { ...open.call, confirm: open.answer.token, ...(open.answer.typeToConfirm ? { typed } : {}) };
      open.resolve(await settle(await callSurfaceApp(repeat), open.call));
    } catch (e) {
      open.reject(e);
    }
  };
  // A frame closed while Eos asked leaves nothing waiting.
  useEffect(() => () => pending.current?.reject(new Error("The App closed.")), []);
  const below = asking && (
    <ConfirmBelow asking={asking} typed={typed} onType={setTyped} onConfirm={() => void answer(true)} onCancel={() => void answer(false)} />
  );
  return { onCall, below };
}

// The Forge builds an Extension from the App; its run shows how it goes.
async function promote(surface, title) {
  const r = await promoteApp(surface.id, title);
  if (r.runId) openLocation(buildLocation({ screen: "run", runId: r.runId }));
  else notify.error(r.error, { title: "The Forge did not start" });
}

// A routine's App (05 Q7, SurfaceApp.dc.html): its title and maker, Pin to
// Home, Open as a tool, the App in its sandboxed frame calling Eos only
// through the core, and the line of access Eos wrote from its manifest. With
// Apps off in Settings it shows its summary only. `inPanel`: the side
// panel's tab; else the full window.
export function AppSurface({ surfaceId, inPanel = false }) {
  const { pages, versions } = usePages();
  const { list: routines } = useRoutines();
  const appsOn = useSettingOr("genui.apps", true);
  useEffect(() => {
    ensureRoutinesLoaded();
    ensurePinsLoaded();
    void loadPage(surfaceId);
  }, [surfaceId]);
  const surface = pages[surfaceId]?.surface;
  const n = surface?.currentVersion;
  useEffect(() => { if (n != null) void loadVersion(surfaceId, n); }, [surfaceId, n]);
  const { onCall, below } = useAppCalls(surfaceId, n);

  const page = pages[surfaceId];
  if (page?.failed === "gone") return <p className="eos-note">This App is no longer here.</p>;
  if (page?.failed === "error") return <LoadFailed what="this App" retry={() => void loadPage(surfaceId)} />;
  if (!surface) return <Loading blocks={3} />;
  const routine = routines?.find((r) => r.id === surface.routineId);
  const version = n != null ? versions[versionKey(surfaceId, n)] : null;
  const manifest = version?.body?.manifest ?? {};
  return (
    <section className={inPanel ? "eos-app eos-app--panel" : "eos-app"} aria-label={`App: ${surface.title}`}>
      <div className="eos-app__head">
        <div className="eos-app__name">
          <div className="eos-app__title">{manifest.title ?? surface.title}</div>
          <div className="eos-app__maker">An app made by {routine?.name ?? "a routine"}</div>
        </div>
        <PinButton surface={surface} />
        {!inPanel && n != null && (
          <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void promote(surface, manifest.title ?? surface.title)}>
            Make it an Extension
          </button>
        )}
        {inPanel && (
          <button type="button" className="eos-btn eos-btn--quiet" onClick={() => openLocation(buildLocation({ screen: "surface", surfaceId }))}>
            Open as a tool
          </button>
        )}
      </div>
      {n == null && <p className="eos-note">No App yet. It shows here once its review and its tests pass and you keep it.</p>}
      {n != null && !version && <Loading blocks={3} />}
      {version && !appsOn && (
        <p className="eos-note">{manifest.summary} Apps are switched off in Settings, so it does not run.</p>
      )}
      {version && appsOn && (
        <div className="eos-app__stage">
          <AppFrame
            viewId={`surface-${surfaceId}`}
            title={manifest.title ?? surface.title}
            html={version.body?.html}
            height={manifest.height}
            summary={manifest.summary}
            onCall={onCall}
            mode={inPanel ? "panel" : "inline"}
          />
          {below && <div className="eos-frame__eos">{below}</div>}
        </div>
      )}
      {version?.accessLine && (
        <p className="eos-app__access">
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16"><path d="M4 7.5h8v5.5H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" /></svg>
          Runs in a sandbox. {version.accessLine}
        </p>
      )}
    </section>
  );
}
