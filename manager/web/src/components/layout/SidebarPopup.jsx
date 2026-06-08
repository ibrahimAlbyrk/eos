// Popup chrome around a view's sidebar("popup") content. Mounted once by the
// Shell, so switching views swaps only the children — the container persists and
// the entry animation fires only on a genuine open, never on a view switch.
export function SidebarPopup({ children }) {
  return <div className="side-handle-popup side-island">{children}</div>;
}
