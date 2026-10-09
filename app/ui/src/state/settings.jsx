import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "../settings/registry.jsx";
import { THEME_STORAGE_KEY, setTheme } from "../settings/theme.js";
import { useComposer } from "./composer.jsx";
import { useSelection } from "./selection.jsx";
import { notify } from "../lib/notify.js";
import { setGenuiSettings } from "../genui/runtime/genuiSettings.js";

const SettingsContext = createContext(null);

// Settings the DAEMON reads live from ~/.eos/config.json (archive sweeper, the
// compaction trigger) — they load/persist through their own endpoints and sit in
// the flat map under their block prefix ("archive.retention", "compaction.threshold").
// `settle`: the PUT answers with the whole block, which the map adopts — a value
// the daemon refused reverts (with a notice) instead of showing as saved.
const CONFIG_BLOCKS = {
  archive: { load: () => api.getArchiveConfig(), patch: (p) => api.patchArchiveConfig(p) },
  compaction: { load: () => api.getCompactionConfig(), patch: (p) => api.patchCompactionConfig(p) },
  // Visual answers (GET/PUT /api/settings/genui, ui-token): level, apps,
  // locationShare, logoDevKey. The kit reads the logo key from genuiSettings.
  genui: {
    load: () => api.getGenuiSettings().then((s) => { setGenuiSettings(s); return s; }),
    patch: (p) => api.patchGenuiSettings(p),
    settle: true,
    adopt: (s) => setGenuiSettings(s),
  },
};
const configBlockOf = (key) => Object.keys(CONFIG_BLOCKS).find((b) => key.startsWith(`${b}.`));

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
  // The daemon-persisted values have arrived (or failed to — defaults stand), so
  // a one-shot decision on a stored flag (the first-run welcome) can't misfire.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const loaded = useRef(false);

  const openSettings = useCallback((sectionId) => {
    if (sectionId) setSettingsSection(sectionId);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const applyBlock = useCallback((block, cfg) => {
    if (!cfg || typeof cfg !== "object") return;
    setSettings((v) => ({
      ...v,
      ...Object.fromEntries(Object.entries(cfg).map(([k, val]) => [`${block}.${k}`, val])),
    }));
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api.getSettings()
      .then((s) => setSettings((v) => ({ ...v, ...s })))
      .catch(() => { loaded.current = false; })
      .finally(() => setSettingsLoaded(true));
    // config.json-backed blocks merge in flat-key form. A failed load keeps the
    // registry defaults.
    for (const [block, io] of Object.entries(CONFIG_BLOCKS)) {
      io.load().then((cfg) => applyBlock(block, cfg)).catch(() => {});
    }
  }, [applyBlock]);

  // Manual expand/collapse clicks are XOR overrides against the verbose
  // defaults — a verbose.* change would render every previously-clicked tool
  // row inverted to the new default, so drop the toggles with the change.
  const { resetToolToggles } = useSelection();
  const setSetting = useCallback((key, value) => {
    if (key.startsWith("verbose.")) resetToolToggles();
    setSettings((v) => ({ ...v, [key]: value }));
    // Config-backed blocks persist to config.json (see the load above), never settings.json.
    const block = configBlockOf(key);
    if (block) {
      const io = CONFIG_BLOCKS[block];
      CONFIG_BLOCKS[block].patch({ [key.slice(block.length + 1)]: value })
        .then((r) => {
          if (!io.settle) return;
          if (r?.ok && r.body) {
            applyBlock(block, r.body);
            io.adopt?.(r.body);
            return;
          }
          notify.error(r?.body?.error ?? "Couldn't save the setting");
          io.load().then((cfg) => applyBlock(block, cfg)).catch(() => {});
        })
        .catch(() => {});
      return;
    }
    api.patchSettings({ [key]: value }).catch(() => {});
  }, [resetToolToggles, applyBlock]);

  // Default-model setting seeds the composer (what new agents spawn with);
  // per-agent changes stay in the model popover and don't touch the setting.
  // Prefer the last-launched model (cm:lastLaunched) so Cmd+T reopens with the
  // same model the user last used, not the stale server default.
  const { updateComposer } = useComposer();
  const defaultModel = settings["model.default"];
  useEffect(() => {
    try {
      const last = JSON.parse(localStorage.getItem("cm:lastLaunched") ?? "null");
      if (last?.model) { updateComposer({ model: last.model }); return; }
    } catch {}
    if (defaultModel) updateComposer({ model: defaultModel });
  }, [defaultModel, updateComposer]);

  // Provider setting seeds the composer's provider NAME (what new agents launch
  // on); empty → server default. Mirrors the default-model seeding above. Resolved
  // to backendKind/backendProfile at spawn time (providerSpawn).
  // Prefer the last-launched provider (cm:lastLaunched) so Cmd+T reopens with
  // the same provider as the last-launched agent instead of the stored setting.
  const defaultProvider = settings["model.provider"];
  useEffect(() => {
    try {
      const last = JSON.parse(localStorage.getItem("cm:lastLaunched") ?? "null");
      if (last?.provider) { updateComposer({ provider: last.provider }); return; }
    } catch {}
    updateComposer({ provider: defaultProvider || null });
  }, [defaultProvider, updateComposer]);

  // Dark only — apply once on mount and persist so index.html's pre-bundle
  // bootstrap paints dark too. The Appearance setting was removed.
  useEffect(() => {
    try { localStorage.setItem(THEME_STORAGE_KEY, "dark"); } catch { /* private mode */ }
    setTheme("dark");
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.altKey || e.shiftKey) return;
      if (e.key !== "," && e.key !== "ö" && e.key !== "Ö") return;
      e.preventDefault();
      setSettingsOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const value = useMemo(
    () => ({ settingsOpen, openSettings, closeSettings, settingsSection, setSettingsSection, settings, settingsLoaded, setSetting }),
    [settingsOpen, openSettings, closeSettings, settingsSection, setSettingsSection, settings, settingsLoaded, setSetting],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

// One value for leaf components that may render outside the provider (tests,
// previews): the registry default when there is no provider.
export function useSettingOr(key, fallback) {
  const c = useContext(SettingsContext);
  return c ? (c.settings[key] ?? fallback) : fallback;
}

export function useSettings() {
  const c = useContext(SettingsContext);
  if (!c) throw new Error("useSettings outside SettingsProvider");
  return c;
}
