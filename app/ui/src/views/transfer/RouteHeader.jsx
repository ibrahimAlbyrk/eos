import { useCallback, useRef, useState } from "react";
import { MachineGlyph } from "../../components/machines/MachineGlyph.jsx";
import { CheckIcon, LockIcon } from "../../components/machines/icons.jsx";
import { useOutsideClose } from "../../components/machines/useOutsideClose.js";
import { latencyLabel, linkTone, routeLabel } from "../../state/hostsStore.js";
import { ChevronDownIcon, SwapIcon } from "./icons.jsx";

// From ⇄ To: this Mac on one side, a paired Mac on the other (picked from a menu
// when there are several), a swap between them, and how the link runs.
export function RouteHeader({ from, to, peer, peers, onPickPeer, onSwap }) {
  const link = peer.link;
  const latency = latencyLabel(link);
  const live = link?.state === "live";
  return (
    <div className="tx-route">
      <div className="tx-pair">
        <Side role="From" machine={from} peers={from.ref === "local" ? null : peers} onPick={onPickPeer} />
        <button type="button" className="tx-swap" aria-label="Swap direction" title="Swap direction" onClick={onSwap}>
          <SwapIcon />
        </button>
        <Side role="To" machine={to} peers={to.ref === "local" ? null : peers} onPick={onPickPeer} />
      </div>
      <div className={"tx-routeline" + (live ? "" : " is-warn")}>
        <LockIcon size={12} />
        <span>{live ? [routeLabel(link), latency, "end-to-end encrypted"].filter(Boolean).join(" · ") : `${peer.label} · ${routeLabel(link).toLowerCase()}`}</span>
      </div>
    </div>
  );
}

function Side({ role, machine, peers, onPick }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const menu = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(menu, btn, close);
  const pickable = Boolean(peers) && peers.length > 1;
  const tone = machine.link ? linkTone(machine.link) : "ok";
  return (
    <div className="tx-side">
      <button
        ref={btn}
        type="button"
        className="tx-mcard"
        disabled={!pickable}
        aria-haspopup={pickable ? "menu" : undefined}
        aria-expanded={pickable ? open : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <MachineGlyph name={machine.name} platform={machine.platform} tone={tone} size="lg" />
        <span className="tx-mcard__text">
          <span className="tx-mcard__role">{role}</span>
          <span className="tx-mcard__name">{machine.label}</span>
        </span>
        {pickable && <span className="tx-mcard__chev"><ChevronDownIcon /></span>}
      </button>
      {open && pickable && (
        <div ref={menu} className="tx-menu glass-pop" role="menu">
          {peers.map((p) => {
            const offline = p.link?.state !== "live" && p.link?.state !== "connecting" && p.link?.state !== "reconnecting";
            return (
              <button
                key={p.ref}
                type="button"
                role="menuitem"
                className="tx-menu__item"
                disabled={offline}
                onClick={() => { onPick(p.ref); close(); }}
              >
                <MachineGlyph name={p.name} platform={p.platform} tone={linkTone(p.link)} />
                <span className="tx-menu__name">{p.label}</span>
                <span className="tx-menu__meta">{latencyLabel(p.link) ?? routeLabel(p.link).toLowerCase()}</span>
                {p.ref === machine.ref && <span className="tx-menu__check"><CheckIcon /></span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
