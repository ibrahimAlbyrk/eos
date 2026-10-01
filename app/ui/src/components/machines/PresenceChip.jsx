import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/client.js";
import { useOutsideClose } from "./useOutsideClose.js";
import { usePeer, ensurePeerLoaded, refreshPeer } from "../../state/peerStore.js";
import { isRemoteView } from "../../lib/host.js";
import { PowerIcon, ShieldIcon } from "./icons.jsx";

function PresenceCard({ devices, anchor, onClose, triggerRef }) {
  const ref = useRef(null);
  useOutsideClose(ref, triggerRef, onClose);
  const style = { top: Math.round(anchor.bottom + 8) };
  const disconnect = async (fp) => { await api.disconnectDevice(fp).catch(() => {}); void refreshPeer(); };
  const revoke = async (d) => {
    if (!window.confirm(`Revoke ${d.name}? It will have to pair again to control this Mac.`)) return;
    await api.revokeDevice(d.fp).catch(() => {});
    onClose();
    void refreshPeer();
  };
  return createPortal(
    <div ref={ref} className="host-card" role="dialog" aria-label="Connected computers" style={style}>
      {devices.map((d) => (
        <div key={d.fp}>
          <div className="host-card__head" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
            <span className="mc-card__name">{d.name} is controlling this Mac</span>
            <span className="mc-card__sub"><span className="mono">{d.deviceId}</span> · end-to-end encrypted</span>
          </div>
          <div className="acct-sep" />
          <button type="button" className="acct-action" onClick={() => void disconnect(d.fp)}><PowerIcon />Disconnect</button>
          <button type="button" className="acct-action is-danger" onClick={() => void revoke(d)}><ShieldIcon />Revoke access…</button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// On the Mac being controlled: whoever is connected right now, always visible,
// one click from being cut off.
export function PresenceChip() {
  const { presence } = usePeer();
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);
  const close = useCallback(() => setAnchor(null), []);
  useEffect(() => { ensurePeerLoaded(); }, []);
  if (isRemoteView() || presence.length === 0) return null;
  const label = presence.length === 1 ? `${presence[0].name} connected` : `${presence.length} computers connected`;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={"host-chip" + (anchor ? " on" : "")}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        aria-expanded={Boolean(anchor)}
      >
        <span className="host-chip__dot host-chip__dot--presence" />
        <span>{label}</span>
      </button>
      {anchor && <PresenceCard devices={presence} anchor={anchor} onClose={close} triggerRef={triggerRef} />}
    </>
  );
}
