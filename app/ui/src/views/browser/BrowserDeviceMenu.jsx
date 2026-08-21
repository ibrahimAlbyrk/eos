// Device switcher entries, hung under the phone button. Exactly one is checked:
// emulation is a property of the page, not one of the panel's three modes, so it
// lives in its own store field. Real CDP emulation lands in P8; here picking an
// entry only moves that field.
export const DEVICES = [
  { id: "responsive", label: "Responsive" },
  { id: "mobile", label: "Mobile", size: "375 × 812" },
  { id: "tablet", label: "Tablet", size: "768 × 1024" },
];

export function BrowserDeviceMenu({ device, onPick }) {
  return (
    <div className="pr-menu browser-device-menu" role="menu">
      {DEVICES.map((d) => (
        <button
          key={d.id}
          className={"pr-menu-item" + (device === d.id ? " on" : "")}
          role="menuitemradio"
          aria-checked={device === d.id}
          onClick={() => onPick(d.id)}
        >
          <span>{d.label}</span>
          {d.size && <span className="browser-device-size">{d.size}</span>}
          {device === d.id && (
            <svg className="pr-menu-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m3 8 3 3 7-7" />
            </svg>
          )}
        </button>
      ))}
    </div>
  );
}
