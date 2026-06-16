import { useEffect } from "react";
import { useUi } from "../../state/ui.jsx";
import { selectBackgroundActivity } from "../../lib/backgroundActivity.js";
import { MonitorBeacon } from "./MonitorBeacon.jsx";
import { MonitorPanel } from "./MonitorPanel.jsx";

// Corner activity widget — the single composition point. Collapsed: a pulsing
// beacon whenever any agent runs a background process (Monitor tool / `Bash
// run_in_background`); click to expand a glass panel listing them. Mounted once
// in the Shell so it rides above every view. Expand state reuses ui.openPopover
// ("monitor") so Escape closes it for free (selection.jsx). Renders nothing
// when there is no live background activity — no idle chrome.
export function MonitorWidget({ live }) {
  const { openPopover, openPop, closeAllPops, setSelectedId, topPanelType } = useUi();
  const items = selectBackgroundActivity(live.workers);
  const open = openPopover === "monitor";

  // Click outside the widget closes the panel (Escape is already handled).
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!e.target.closest(".mon-widget")) closeAllPops(); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, closeAllPops]);

  // The last process ended while the panel was open → drop the stale popover.
  useEffect(() => {
    if (open && !items.length) closeAllPops();
  }, [open, items.length, closeAllPops]);

  // A right-panel viewer (file/diff/agent/…) owns the right side — keep the
  // corner widget beneath it by not rendering while one is open, and drop a
  // stale-open monitor popover so it doesn't pop back when the viewer closes.
  useEffect(() => {
    if (topPanelType && open) closeAllPops();
  }, [topPanelType, open, closeAllPops]);

  if (!items.length || topPanelType) return null;

  const toggle = () => (open ? closeAllPops() : openPop("monitor"));

  return (
    <div className="mon-widget">
      {open && (
        <MonitorPanel
          items={items}
          now={live.now}
          onSelect={(id) => { setSelectedId(id); closeAllPops(); }}
          onClose={closeAllPops}
        />
      )}
      <MonitorBeacon count={items.length} open={open} onClick={toggle} />
    </div>
  );
}
