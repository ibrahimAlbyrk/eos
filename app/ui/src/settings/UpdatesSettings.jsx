// Settings › Updates — this Mac's in-app updates: a status card with the next
// step (check, download, restart), whether new versions download on their own,
// and the version. Each computer updates itself, so a view of another one only
// says so.

import { useEffect } from "react";
import { useSettings } from "../state/settings.jsx";
import { ensureUpdateLoaded, updateActions, useUpdate } from "../state/updateStore.js";
import { statusCardOf } from "../lib/updates.js";
import { isRemoteView } from "../lib/host.js";
import { timeAgo } from "../lib/timeAgo.js";
import { shortcutLabel } from "../lib/platform.js";
import { ToggleControl } from "./controls.jsx";
import { UpdateMark } from "../views/update/UpdateMark.jsx";
import { useOpenReleaseNotes } from "../views/update/useOpenReleaseNotes.js";

const ACTIONS = {
  check: { label: "Check now", run: () => updateActions.check() },
  download: { label: "Download", run: () => updateActions.download() },
  restart: { label: "Restart now", run: () => updateActions.restart("now") },
};

export function UpdatesSettings() {
  const state = useUpdate();
  const { closeSettings } = useSettings();
  const openNotes = useOpenReleaseNotes();
  useEffect(() => { if (!isRemoteView()) ensureUpdateLoaded(); }, []);

  if (isRemoteView()) {
    return (
      <>
        <h2 className="stg-title">Updates</h2>
        <div className="stg-row__desc">Each computer updates itself. Switch to it with {shortcutLabel("ctrl+1")} to see this Mac's.</div>
      </>
    );
  }
  if (!state) return <h2 className="stg-title">Updates</h2>;

  const card = statusCardOf(state);
  const off = state.status.phase === "off";
  const busy = ["checking", "downloading", "staging", "applying"].includes(state.status.phase);
  const showNotes = (version) => { closeSettings(); openNotes(version); };

  return (
    <>
      <h2 className="stg-title">Updates</h2>

      <div className={`up-card is-${card.tone}`}>
        <UpdateMark size={26} />
        <div className="up-card__text">
          <span className="up-card__title">{card.title}</span>
          {card.detail && <span className="up-card__detail">{card.detail}</span>}
          {card.progress != null && (
            <div className="up-meter up-card__meter"><div className="up-meter__fill" style={{ width: `${card.progress * 100}%` }} /></div>
          )}
        </div>
        {card.action === "restart" && (
          <button type="button" className="up-btn" onClick={() => showNotes(state.status.version)}>What’s new</button>
        )}
        {card.action && (
          <button type="button" className={"up-btn" + (card.action === "check" ? "" : " up-btn--primary")} onClick={ACTIONS[card.action].run}>
            {ACTIONS[card.action].label}
          </button>
        )}
      </div>

      {!off && (
        <div className="stg-group">
          <div className="stg-group__title">Automatic updates</div>
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Download updates automatically</div>
              <div className="stg-row__desc">New versions download in the background. Eos asks before it restarts.</div>
            </div>
            <ToggleControl value={state.autoDownload} onChange={(on) => void updateActions.setAutoDownload(on)} />
          </div>
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Check for updates</div>
              <div className="stg-row__desc">{state.lastCheckedAt ? `Last checked ${timeAgo(state.lastCheckedAt)}` : "Eos checks when it opens and every half hour"}</div>
            </div>
            <button type="button" className="m-btn m-btn--sm" disabled={busy} onClick={() => void updateActions.check()}>Check now</button>
          </div>
        </div>
      )}

      <div className="stg-group">
        <div className="stg-group__title">About</div>
        <div className="stg-row">
          <div className="stg-row__label">Version</div>
          <span className="up-version">{state.current ?? "Built from source"}</span>
        </div>
        <div className="stg-row">
          <div className="stg-row__label">Release notes</div>
          <button type="button" className="up-link" onClick={() => showNotes(null)}>View all</button>
        </div>
      </div>
    </>
  );
}
