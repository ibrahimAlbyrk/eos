import { useUi } from "../../../state/ui.jsx";
import { notify } from "../../../lib/notify.js";
import { toDatetimeLocal, nextMorning } from "../../../lib/scheduleTime.js";

// Small popover behind the composer clock button: quick chips + a datetime-local
// input. Picking any option resolves an absolute epoch-ms fireAt and hands it up
// via onPick, putting the composer into schedule mode (see Composer.send).
export function SchedulePopover({ onPick }) {
  const ui = useUi();
  if (ui.openPopover !== "schedule") return null;

  const now = Date.now();
  const chips = [
    { label: "30 dk", at: now + 30 * 60000 },
    { label: "1 saat", at: now + 60 * 60000 },
    { label: "Yarın 09:00", at: nextMorning(now) },
  ];

  const pick = (at) => {
    if (at <= Date.now()) {
      notify.error("Geçmiş bir zaman seçilemez.");
      return;
    }
    ui.closeAllPops();
    onPick(at);
  };

  return (
    <div className="schedule-popover glass-pop open" data-popover="schedule">
      <div className="schedule-pop-chips">
        {chips.map((c) => (
          <button key={c.label} className="schedule-chip" onClick={() => pick(c.at)}>
            {c.label}
          </button>
        ))}
      </div>
      <label className="schedule-pop-custom">
        <span>Özel zaman</span>
        <input
          type="datetime-local"
          min={toDatetimeLocal(now)}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const at = new Date(v).getTime();
            if (!Number.isNaN(at)) pick(at);
          }}
        />
      </label>
    </div>
  );
}
