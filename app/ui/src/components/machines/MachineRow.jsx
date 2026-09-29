import { useEffect, useRef } from "react";
import { useUi } from "../../state/ui.jsx";
import { useSettings } from "../../state/settings.jsx";
import { useNavigation } from "../../state/navigation.jsx";
import { useKeybinding } from "../../keymap/useKeymap.js";
import { combo } from "../../keymap/index.js";
import {
  useHosts, ensureHostsLoaded, hostLabel, linkTone, openConnectSheet, routeLabel,
} from "../../state/hostsStore.js";
import { currentHost, isRemoteView } from "../../lib/host.js";
import { MachineGlyph } from "./MachineGlyph.jsx";
import { MachinesMenu } from "./MachinesMenu.jsx";
import { UpDownIcon } from "./icons.jsx";

// The sidebar footer's machine row — which computer this window is driving, and
// the way to every other one (like VS Code's remote indicator, bottom-left).
export function MachineRow({ live }) {
  const ui = useUi();
  const { openSettings } = useSettings();
  const { setActiveView } = useNavigation();
  const { hosts, local } = useHosts();
  const ref = useRef(null);
  useEffect(() => { ensureHostsLoaded(); }, []);

  const open = ui.openPopover === "machines-menu";
  const toggle = (e) => {
    e?.stopPropagation();
    if (open) ui.closeAllPops();
    else ui.openPop("machines-menu");
  };
  useKeybinding({ match: combo("mod+shift+m"), terminalSafe: true, run: () => toggle() }, [open]);

  const remote = isRemoteView();
  const host = remote ? hosts.find((h) => h.id === currentHost()?.id) ?? null : null;
  const name = remote ? hostLabel(host ?? currentHost()) : local?.name ?? "This Mac";
  const tone = remote ? linkTone(host?.link) : "ok";
  const meta = !remote ? "This Mac"
    : host?.link?.state === "live" ? (host.link.route === "relay" ? "Relay" : "LAN")
    : routeLabel(host?.link).toLowerCase();

  const run = (fn) => () => { ui.closeAllPops(); fn(); };
  const anchor = open ? ref.current?.getBoundingClientRect() : null;

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={"machine-row" + (open ? " on" : "")}
        onClick={toggle}
        data-popover-trigger="machines-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Machines (⌘⇧M)"
      >
        <MachineGlyph name={remote ? host?.name ?? name : local?.name} platform={remote ? host?.platform : local?.platform} tone={tone} />
        <span className="machine-row__name">{name}</span>
        <span className={"machine-row__meta" + (tone === "warn" ? " is-warn" : tone === "err" ? " is-err" : "")}>{meta}</span>
        <span className="machine-row__chev"><UpDownIcon /></span>
      </button>
      {anchor && (
        <MachinesMenu
          anchor={anchor}
          live={live}
          onConnect={run(openConnectSheet)}
          onAllMachines={run(() => setActiveView("machines"))}
          onRemoteAccess={run(() => openSettings("remote"))}
        />
      )}
    </>
  );
}
