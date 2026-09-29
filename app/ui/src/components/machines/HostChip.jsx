import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOutsideClose } from "./useOutsideClose.js";
import {
  useHosts, ensureHostsLoaded, hostLabel, linkTone, routeLabel, latencyLabel,
  switchMachine, openMachineWindow, reconnectMachine, canSwitchMachines,
} from "../../state/hostsStore.js";
import { currentHost, isRemoteView } from "../../lib/host.js";
import { MachineGlyph } from "./MachineGlyph.jsx";
import { CloudIcon, HomeIcon, LanIcon, LockIcon, RefreshIcon, WindowIcon } from "./icons.jsx";

function ConnectionCard({ host, anchor, onClose, triggerRef }) {
  const ref = useRef(null);
  useOutsideClose(ref, triggerRef, onClose);
  const link = host?.link;
  const lat = latencyLabel(link);
  const tone = linkTone(link);
  const style = { left: Math.round(anchor.left), top: Math.round(anchor.bottom + 8) };
  const act = (fn) => () => { onClose(); fn(); };
  return createPortal(
    <div ref={ref} className="host-card" role="dialog" aria-label={`${hostLabel(host)} connection`} style={style}>
      <div className="host-card__head">
        <MachineGlyph name={host?.name} platform={host?.platform} tone={tone} size="lg" />
        <div className="mc-card__text">
          <span className="mc-card__name">{hostLabel(host)}</span>
          <span className="mc-card__sub">{link?.state === "live" ? "Connected · you're controlling this computer" : routeLabel(link)}</span>
        </div>
      </div>
      <div className="acct-sep" />
      <div className="host-card__rows">
        <div className="kv">
          <span className="kv__k">Route</span>
          <span className="kv__v">
            {link?.route === "relay" ? <CloudIcon /> : <LanIcon />}
            {link?.state === "live" ? (link.route === "relay" ? "Relay" : "Local network, direct") : "—"}
          </span>
        </div>
        <div className="kv"><span className="kv__k">Latency</span><span className="kv__v"><span className="mono">{lat ?? "—"}</span></span></div>
        <div className="kv"><span className="kv__k">Encryption</span><span className="kv__v"><LockIcon />End-to-end</span></div>
        <div className="kv"><span className="kv__k">Device ID</span><span className="kv__v"><span className="mono">{host?.deviceId ?? "—"}</span></span></div>
      </div>
      <div className="acct-sep" />
      {canSwitchMachines() && <button type="button" className="acct-action" onClick={act(() => openMachineWindow(host.id))}><WindowIcon />Open in new window</button>}
      <button type="button" className="acct-action" onClick={act(() => reconnectMachine(host.id))}><RefreshIcon />Reconnect</button>
      {canSwitchMachines() && <button type="button" className="acct-action" onClick={act(() => switchMachine(null))}><HomeIcon />Back to This Mac<span className="acct-kbd">⌃1</span></button>}
    </div>,
    document.body,
  );
}

// A controlled computer's window says so, always, in the title row: which
// computer, and how the link is doing. This Mac's own window shows nothing here.
export function HostChip() {
  const { hosts } = useHosts();
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);
  const close = useCallback(() => setAnchor(null), []);
  useEffect(() => { ensureHostsLoaded(); }, []);
  if (!isRemoteView()) return null;
  const desc = currentHost();
  const host = hosts.find((h) => h.id === desc?.id) ?? { ...desc, link: null };
  const tone = linkTone(host.link);
  const lat = latencyLabel(host.link);
  // Down links read as one word in the chip; the banner and card say the rest.
  const status = lat ?? (host.link?.state === "live" ? "" : host.link?.state === "reconnecting" || host.link?.state === "connecting" ? "…" : routeLabel(host.link).toLowerCase());
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={"host-chip" + (anchor ? " on" : "")}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        aria-expanded={Boolean(anchor)}
        aria-label={`${hostLabel(host)} connection details`}
      >
        <span className={`host-chip__dot host-chip__dot--${tone}`} />
        <span>{hostLabel(host)}</span>
        {status && <span className={"host-chip__lat" + (tone === "warn" ? " is-warn" : tone === "err" ? " is-err" : "")}>{status}</span>}
      </button>
      {anchor && <ConnectionCard host={host} anchor={anchor} onClose={close} triggerRef={triggerRef} />}
    </>
  );
}
