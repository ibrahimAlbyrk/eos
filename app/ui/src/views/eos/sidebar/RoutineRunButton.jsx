import { open, useRunSheet } from "../../../state/eos/runSheetStore.js";

// Opens the run sheet beside the button; shown only once a sheet is hosted.
export function RoutineRunButton({ routine }) {
  const { hosted } = useRunSheet();
  if (hosted === 0) return null;
  return (
    <button
      type="button"
      className="eos-side-run"
      aria-label={`Run ${routine.name}`}
      title={`Run ${routine.name}`}
      onClick={(e) => open({ routineId: routine.id, anchor: e.currentTarget })}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor" /></svg>
    </button>
  );
}
