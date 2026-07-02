import { useUi } from "../../../state/ui.jsx";
import { PERMISSION_MODES } from "../../../lib/permissionModes.jsx";

export function AcceptPopover({ live, worker }) {
  const ui = useUi();
  if (ui.openPopover !== "accept") return null;
  // This pane's own worker (not the global selection) — a non-focused pane's
  // menu must reflect ITS agent's permission mode, not the selected pane's.
  const selected = worker ?? null;
  const current = selected?.permission_mode ?? ui.composer.permissionMode;

  const pick = async (mode) => {
    if (selected) await live.setPermissionMode(selected.id, mode);
    else ui.updateComposer({ permissionMode: mode });
    ui.closeAllPops();
  };

  return (
    <div className="accept-popover glass-pop open" id="acceptPopover" data-popover="accept">
      <div className="ap-head">Permission mode</div>
      {PERMISSION_MODES.map((m) => (
        <button
          key={m.id}
          className={"ap-option" + (current === m.id ? " on" : "")}
          onClick={() => pick(m.id)}
        >
          <span className="ap-radio"></span>
          <div className="ap-text">
            <div className="ap-label">
              <m.Icon className="ap-ic" />
              {m.label}
            </div>
            <div className="ap-desc">{m.desc}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
