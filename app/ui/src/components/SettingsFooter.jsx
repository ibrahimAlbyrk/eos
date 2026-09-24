import { useRef } from "react";
import { useSettings } from "../state/settings.jsx";
import { useUi } from "../state/ui.jsx";
import { AccountMenu } from "./AccountMenu.jsx";

// Bottom row of every view's sidebar: a profile row (avatar + name) that opens
// the Account menu (plan usage, total cost, Settings) — the way into Settings
// besides ⌘,. No daemon status (removed by the user). The name is a placeholder
// until a profile source exists.
export function SettingsFooter({ live }) {
  const { openSettings } = useSettings();
  const ui = useUi();
  const ref = useRef(null);
  const open = ui.openPopover === "account-menu";

  const toggle = (e) => {
    e.stopPropagation();
    if (open) ui.closeAllPops();
    else ui.openPop("account-menu");
  };
  const openFromMenu = (sectionId) => {
    ui.closeAllPops();
    openSettings(sectionId);
  };

  const anchor = open ? ref.current?.getBoundingClientRect() : null;
  const totalCostUsd = (live?.workers ?? []).reduce((sum, w) => sum + (w.cost_usd ?? 0), 0);

  return (
    <div className="sb-settings" ref={ref}>
      <button
        className={"sb-settings__account" + (open ? " on" : "")}
        onClick={toggle}
        data-popover-trigger="account-menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="sb-settings__avatar" aria-hidden="true" />
        <span className="sb-settings__name">Account</span>
      </button>
      {anchor && <AccountMenu anchor={anchor} totalCostUsd={totalCostUsd} onOpenSettings={openFromMenu} />}
    </div>
  );
}
