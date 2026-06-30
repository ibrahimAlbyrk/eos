import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "../settings/registry.jsx";
import { THEME_KEY, THEME_STORAGE_KEY, resolveTheme, setTheme, watchSystemTheme } from "../settings/theme.js";
import { useComposer } from "./composer.jsx";
import { useSelection } from "./selection.jsx";

const SettingsContext = createContext(null);

// Owns the settings modal's open state, the global ⌘, / Ctrl+, shortcut and
// the daemon-persisted settings map. Values load once on mount (settings like
// verbose mode drive rendering, not just the modal) and are written
// optimistically (fire-and-forget PUT), mirroring the localStorage helpers'
// spirit — but daemon-side, so they survive webview data resets and apply
// across app/browser.
export function SettingsProvider({ children }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState(SETTINGS_SECTIONS[0]?.id ?? null);
  const [settings, setSettings] = useState(SETTING_DEFAULTS);
  const loaded = useRef(false);
  const themeChangedByUser = useRef(false);

  const openSettings = useCallback((sectionId) => {
    if (sectionId) setSettingsSection(sectionId);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api.getSettings()
      .then((s) => setSettings((v) => ({ ...v, ...s })))
      .catch(() => { loaded.current = false; });
  }, []);

  // Manual expand/collapse clicks are XOR overrides against the verbose
  // defaults — a verbose.* change would render every previously-clicked tool
  // row inverted to the new default, so drop the toggles with the change.
  const { resetToolToggles } = useSelection();
  const setSetting = useCallback((key, value) => {
    if (key === THEME_KEY) themeChangedByUser.current = true;
    if (key.startsWith("verbose.")) resetToolToggles();
    setSettings((v) => ({ ...v, [key]: value }));
    api.patchSettings({ [key]: value }).catch(() => {});
  }, [resetToolToggles]);

  // Default-model setting seeds the composer (what new agents spawn with);
  // per-agent changes stay in the model popover and don't touch the setting.
  const { updateComposer } = useComposer();
  const defaultModel = settings["model.default"];
  useEffect(() => {
    if (defaultModel) updateComposer({ model: defaultModel });
  }, [defaultModel, updateComposer]);

  // Provider setting seeds the composer's provider NAME (what new agents launch
  // on); empty → server default. Mirrors the default-model seeding above. Resolved
  // to backendKind/backendProfile at spawn time (providerSpawn).
  const defaultProvider = settings["model.provider"];
  useEffect(() => {
    updateComposer({ provider: defaultProvider || null });
  }, [defaultProvider, updateComposer]);

  // Apply theme whenever the setting changes; animate only user-initiated
  // switches (not the load merge or a macOS appearance flip in system mode).
  useEffect(() => {
    const setting = settings[THEME_KEY] ?? "system";
    try { localStorage.setItem(THEME_STORAGE_KEY, setting); } catch { /* private mode */ }
    const animate = themeChangedByUser.current;
    themeChangedByUser.current = false;
    setTheme(resolveTheme(setting), { animate });
    if (setting !== "system") return;
    return watchSystemTheme(() => setTheme(resolveTheme("system"), { animate: false }));
  }, [settings]);

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
