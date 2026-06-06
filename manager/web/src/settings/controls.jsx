// Control renderers keyed by `control.type` from the settings registry.
// Every control receives { value, onChange } plus the rest of its registry
// `control` props. Adding a control type = one component + one CONTROLS entry.

function ToggleControl({ value, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!value}
      className={`stg-toggle${value ? " is-on" : ""}`}
      onClick={() => onChange(!value)}
    >
      <span className="stg-toggle__knob" />
    </button>
  );
}

export const CONTROLS = {
  toggle: ToggleControl,
};
