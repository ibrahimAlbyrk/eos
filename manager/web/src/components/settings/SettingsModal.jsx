import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../../state/settings.jsx";
import { SETTINGS_SECTIONS } from "../../settings/registry.jsx";
import { CONTROLS } from "../../settings/controls.jsx";

function itemMatches(item, q) {
  return [item.label, item.description, item.key]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q);
}

// Sections narrowed to the query: groups keep only matching items, sections
// with no hits (and no custom Component) drop out of the nav entirely.
function filterSections(sections, q) {
  if (!q) return sections;
  return sections
    .map((s) => {
      if (!s.groups) return s;
      const groups = s.groups
        .map((g) => ({ ...g, items: g.items.filter((i) => itemMatches(i, q)) }))
        .filter((g) => g.items.length);
      return { ...s, groups };
    })
    .filter((s) => !s.groups || s.groups.length);
}

function SectionContent({ section, settings, setSetting }) {
  if (section.Component) return <section.Component />;
  return (
    <>
      <h2 className="stg-title">{section.label}</h2>
      {section.groups.map((g) => (
        <div className="stg-group" key={g.title}>
          <div className="stg-group__title">{g.title}</div>
          {g.items.filter((item) => !item.visibleWhen || item.visibleWhen(settings)).map((item) => {
            const Control = CONTROLS[item.control.type];
            const stacked = item.control.layout === "stack";
            return (
              <div className={"stg-row" + (stacked ? " stg-row--stack" : "")} key={item.key}>
                <div className="stg-row__text">
                  <div className="stg-row__label">{item.label}</div>
                  {item.description && <div className="stg-row__desc">{item.description}</div>}
                </div>
                {Control && (
                  <Control
                    {...item.control}
                    value={settings[item.key] ?? item.defaultValue}
                    onChange={(v) => setSetting(item.key, v)}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// Centered settings dialog. Global (mounted once in the Shell) so it works on
// any tab. Sections/items live in the settings registry; this component only
// renders the active section and the query-narrowed nav.
export function SettingsModal() {
  const { settingsOpen, closeSettings, settingsSection, setSettingsSection, settings, setSetting } = useSettings();
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!settingsOpen) { setQuery(""); return; }
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [settingsOpen]);

  // Capture phase so Escape doesn't fall through to the app-wide chain while
  // the modal is open (same contract as the command palette).
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [settingsOpen, closeSettings]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => filterSections(SETTINGS_SECTIONS, q), [q]);

  if (!settingsOpen) return null;

  const active = visible.find((s) => s.id === settingsSection) ?? visible[0];

  return (
    <div className="stg-overlay" onMouseDown={closeSettings}>
      <div className="stg-modal glass-pop" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <aside className="stg-nav">
          <div className="stg-search">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7" cy="7" r="5" />
              <path d="m13 13-2.5-2.5" />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              spellCheck={false}
            />
          </div>
          <div className="stg-nav__label">Settings</div>
          {visible.map((s) => (
            <button
              key={s.id}
              className={"stg-nav__item" + (active?.id === s.id ? " is-active" : "")}
              onClick={() => setSettingsSection(s.id)}
            >
              <s.Icon />
              <span>{s.label}</span>
            </button>
          ))}
        </aside>

        <section className="stg-body">
          {active
            ? <SectionContent section={active} settings={settings} setSetting={setSetting} />
            : <div className="stg-empty">No matching settings</div>}
        </section>

        <button className="stg-close" title="Close (Esc)" onClick={closeSettings}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
}
