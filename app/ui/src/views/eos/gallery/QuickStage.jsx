import { QuickPanel } from "../quick/QuickPanel.jsx";

// The quick panel as the shell shows it over another app, with doors that
// answer from the state: what a door holds, whether Accessibility is
// allowed, and whether the Start-at-login offer was answered. Nothing
// reaches the shell.
export function galleryDoors({ item = null, trusted = true, offered = true }) {
  return {
    held: async () => item,
    onHeld: () => () => {},
    closePanel: () => {},
    sizePanel: () => {},
    accessibility: async () => ({ available: true, trusted }),
    openAccessibilitySettings: async () => {},
    loginItem: async () => ({ available: true, offered, state: "off" }),
    setLoginItem: async () => ({ available: true, offered: true, state: "off" }),
  };
}

export function QuickStage({ quick }) {
  return (
    <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 120, minHeight: "100vh", background: "var(--bg)" }}>
      <QuickPanel doors={galleryDoors(quick)} />
    </div>
  );
}
