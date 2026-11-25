import { useEffect } from "react";
import { EosSettings } from "../../../settings/EosSettings.jsx";
import { EosModeIcon } from "../meta.jsx";
import { galleryDoors } from "./QuickStage.jsx";

// The sections the app's Settings lists beside Eos, drawn as names only: the
// gallery shows Settings › Eos as the modal holds it, nothing else of it.
const BESIDE = ["General", "Profile", "Accounts", "Usage", "Plugins", "Remote access", "Machines", "Sync", "Updates"];

// Doors a Mac answers: the quick panel's shortcut and Accessibility, Start at
// login and the eos command, from the state's `doors`.
export function settingsDoors({ trusted = true, held = true, installed = true, login = "on" } = {}) {
  return {
    ...galleryDoors({ trusted }),
    loginItem: async () => ({ available: true, offered: true, state: login }),
    shortcut: async () => ({ available: true, accelerator: "alt+space", held }),
    setShortcut: async (accelerator) => ({ available: true, accelerator, held: true }),
    command: async () => ({ available: true, installed, onPath: installed, path: "/Users/ada/.local/bin/eos" }),
    installCommand: async () => ({ available: true, installed: true, onPath: true, path: "/Users/ada/.local/bin/eos" }),
  };
}

// Settings › Eos inside the app's Settings modal, over Eos's window.
export function SettingsStage({ settings }) {
  if (globalThis.window && !window.eosDoors) window.eosDoors = settingsDoors(settings.doors);
  useEffect(() => () => { delete window.eosDoors; }, []);
  return (
    <div className="stg-overlay" style={{ gridColumn: "1 / -1" }}>
      <div className="stg-modal glass-pop" role="dialog" aria-modal="true" aria-label="Settings">
        <aside className="stg-nav">
          <div className="stg-nav__label">Settings</div>
          {BESIDE.map((name) => <button key={name} type="button" className="stg-nav__item"><span>{name}</span></button>)}
          <button type="button" className="stg-nav__item is-active"><EosModeIcon /><span>Eos</span></button>
        </aside>
        <section className="stg-body"><EosSettings /></section>
      </div>
    </div>
  );
}
