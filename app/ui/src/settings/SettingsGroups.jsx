import { CONTROLS } from "./controls.jsx";

// Settings groups from the registry (settings/registry.jsx), each a titled list
// of rows with their controls — a section's body, or a built-in plugin's page.
export function SettingsGroups({ groups, settings, setSetting }) {
  return groups.map((g) => (
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
  ));
}
