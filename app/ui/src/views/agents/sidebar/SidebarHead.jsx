import { useUi } from "../../../state/ui.jsx";
import { EosSwitcher } from "../../../components/EosSwitcher.jsx";
import { HostChip } from "../../../components/machines/HostChip.jsx";
import { PresenceChip } from "../../../components/machines/PresenceChip.jsx";
import { sidebarNav } from "../../../slots/index.js";
import { SlotBoundary } from "../../../slots/SlotBoundary.jsx";
import { ViewNavRow } from "./NavRow.jsx";

function CollapseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="2" /><line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

// Sidebar top chrome + primary nav, matching the reference IA:
//   full variant → traffic lights + collapse button (the .side-top strip)
//   both variants → Eos ▾ switcher + search, then the nav rows (the sidebarNav
//   slot: New task / Changes / Archive, plus any plugin's rows).
export function SidebarHead({ live, variant }) {
  const ui = useUi();
  const full = variant === "full";
  const navItems = sidebarNav.useItems();

  return (
    <>
      {full && (
        <div className="side-top">
          <span className="side-dot" />
          <span className="side-dot" />
          <span className="side-dot" />
          <button className="side-collapse" title="Collapse panel" onClick={() => ui.collapseSidebar()}>
            <CollapseIcon />
          </button>
          <HostChip />
          <PresenceChip />
        </div>
      )}

      <EosSwitcher />

      <div className="sb-nav">
        {navItems.map((item) => (
          <SlotBoundary key={item.id} name={item.id} resetKey={item}>
            {item.Component ? <item.Component live={live} /> : <ViewNavRow item={item} />}
          </SlotBoundary>
        ))}
      </div>
    </>
  );
}
