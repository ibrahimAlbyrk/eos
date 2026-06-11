import { useUi } from "../../../state/ui.jsx";
import { CommandInfo } from "../center/CommandInfo.jsx";

// Info card for a slash-command pill clicked in the composer. Anchored above
// the input (same plane as CommandMenu); ui.popoverPos.x = pill offset within
// .c-row2-wrap, set by the composer's click delegation.
export function SlashInfoPopover() {
  const ui = useUi();
  if (ui.openPopover !== "slashinfo") return null;
  const cmd = ui.popoverData?.cmd;
  if (!cmd) return null;

  return (
    <div
      className="slash-info glass-pop open"
      data-popover="slashinfo"
      role="dialog"
      aria-label={`/${cmd.name} command info`}
      style={{ left: ui.popoverPos.x }}
    >
      <div className="slash-info-name">/{cmd.name}</div>
      <div className="slash-info-body">
        <CommandInfo cmd={cmd} />
      </div>
      {cmd.argumentHint && <div className="slash-info-hint">{cmd.argumentHint}</div>}
    </div>
  );
}
