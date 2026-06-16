// Single source of truth for the (two) permission modes shown in the UI.
// `bypassPermissions` is surfaced to the user as "Full Access". Consumed by
// the composer mode pill (ComposerControls) and the picker (AcceptPopover).

// Lucide shield body — shared by both glyphs.
const SHIELD = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z";

function Shield({ children, ...props }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" {...props}
    >
      <path d={SHIELD} />
      {children}
    </svg>
  );
}

export function ShieldCheckIcon(props) {
  return <Shield {...props}><path d="m9 12 2 2 4-4" /></Shield>;
}

export function ShieldAlertIcon(props) {
  return <Shield {...props}><path d="M12 8v4" /><path d="M12 16h.01" /></Shield>;
}

export const PERMISSION_MODES = [
  { id: "acceptEdits", label: "Accept edits", desc: "Auto-approve file edits, ask for shell", Icon: ShieldCheckIcon },
  { id: "bypassPermissions", label: "Full Access", desc: "Auto-approve everything, including shell", Icon: ShieldAlertIcon },
];

export const MODE_BY_ID = Object.fromEntries(PERMISSION_MODES.map((m) => [m.id, m]));
