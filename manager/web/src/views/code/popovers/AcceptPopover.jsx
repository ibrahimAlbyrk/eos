import { useUi } from "../../../state/ui.jsx";

const MODES = [
  { id: "default",           label: "Default",       desc: "Ask before every edit and shell command" },
  { id: "acceptEdits",       label: "Accept edits",  desc: "Auto-approve file edits, ask for shell" },
  { id: "plan",              label: "Plan only",     desc: "Worker plans changes, doesn't execute" },
  { id: "bypassPermissions", label: "Bypass all",    desc: "Auto-approve everything, including shell", warn: true },
];

export function AcceptPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "accept") return null;
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const current = selected?.permission_mode ?? ui.composer.permissionMode;

  const pick = async (mode) => {
    if (selected) await live.setPermissionMode(selected.id, mode);
    else ui.updateComposer({ permissionMode: mode });
    ui.closeAllPops();
  };

  return (
    <div className="accept-popover glass-pop open" id="acceptPopover" data-popover="accept">
      <div className="ap-head">Permission mode</div>
      {MODES.map((m) => (
        <button
          key={m.id}
          className={"ap-option" + (current === m.id ? " on" : "")}
          onClick={() => pick(m.id)}
        >
          <span className="ap-radio"></span>
          <div className="ap-text">
            <div className="ap-label">
              {m.label}{m.warn && <span className="warn">⚠</span>}
            </div>
            <div className="ap-desc">{m.desc}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
