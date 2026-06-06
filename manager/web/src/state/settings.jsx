import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "../settings/registry.jsx";

const SettingsContext = createContext(null);

// Owns the settings modal's open state, the global ⌘, / Ctrl+, shortcut and
// the daemon-persisted settings map. Values are fetched on first open and
// written optimistically (fire-and-forget PUT), mirroring the localStorage
// helpers' spirit — but daemon-side, since Eos.app wipes localStorage.
export function SettingsProvider({ children }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState(SETTINGS_SECTIONS[0]?.id ?? null);
  const [settings, setSettings] = useState(SETTING_DEFAULTS);
  const loaded = useRef(false);

  const openSettings = useCallback((sectionId) => {
    if (sectionId) setSettingsSection(sectionId);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    if (!settingsOpen || loaded.current) return;
    loaded.current = true;
    api.getSettings()
      .then((s) => setSettings((v) => ({ ...v, ...s })))
      .catch(() => { loaded.current = false; });
  }, [settingsOpen]);

  const setSetting = useCallback((key, value) => {
    setSettings((v) => ({ ...v, [key]: value }));
    api.patchSettings({ [key]: value }).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.altKey || e.shiftKey) return;
      if (e.key !== ",") return;
      e.preventDefault();
      setSettingsOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const value = useMemo(
    () => ({ settingsOpen, openSettings, closeSettings, settingsSection, setSettingsSection, settings, setSetting }),
    [settingsOpen, openSettings, closeSettings, settingsSection, setSettingsSection, settings, setSetting],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const c = useContext(SettingsContext);
  if (!c) throw new Error("useSettings outside SettingsProvider");
  return c;
}
