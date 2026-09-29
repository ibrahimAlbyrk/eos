// Settings › Machines — the computers THIS Mac controls: name them, re-probe a
// link, or forget one. Pairing a new one opens the Connect sheet.

import { useEffect } from "react";
import { api } from "../api/client.js";
import { CONTROLS } from "./controls.jsx";
import {
  useHosts, ensureHostsLoaded, refreshHosts, openConnectSheet, reconnectMachine, switchMachine,
  hostLabel, linkTone, routeLabel, latencyLabel, canManageMachines, canSwitchMachines,
} from "../state/hostsStore.js";
import { MachineGlyph } from "../components/machines/MachineGlyph.jsx";
import { PlusIcon } from "../components/machines/icons.jsx";

const Text = CONTROLS.text;

export function MachinesSettings() {
  const { hosts } = useHosts();
  useEffect(() => { ensureHostsLoaded(); void refreshHosts(); }, []);

  if (!canManageMachines()) {
    return (
      <>
        <h2 className="stg-title">Machines</h2>
        <div className="stg-row__desc">Machines are managed from this Mac's own window — switch back with ⌃1.</div>
      </>
    );
  }

  const rename = async (id, alias) => { await api.updateHost(id, { alias: alias.trim() || null }).catch(() => {}); void refreshHosts(); };
  const forget = async (h) => {
    if (!window.confirm(`Forget ${hostLabel(h)}? You'll need a new invite from it to connect again.`)) return;
    await api.forgetHost(h.id).catch(() => {});
    void refreshHosts();
  };

  return (
    <>
      <h2 className="stg-title">Machines</h2>
      <div className="stg-group">
        <div className="stg-group__title">Computers this Mac controls</div>
        {hosts.length === 0 && (
          <div className="stg-row"><div className="stg-row__desc" style={{ marginTop: 0 }}>None yet. On the other computer, turn on Settings › Remote access and make an invite.</div></div>
        )}
        {hosts.map((h) => {
          const lat = latencyLabel(h.link);
          const tone = linkTone(h.link);
          return (
            <div className="stg-row stg-row--stack" key={h.id} style={{ gap: 12 }}>
              <div className="stg-row" style={{ padding: 0, borderTop: "none" }}>
                <div className="peer-device">
                  <MachineGlyph name={h.name} platform={h.platform} tone={tone} size="lg" />
                  <div className="stg-row__text">
                    <div className="stg-row__label">{hostLabel(h)}{h.alias && <span style={{ color: "var(--fg-faint)" }}> · {h.name}</span>}</div>
                    <div className={"stg-row__desc"} style={{ marginTop: 1, color: tone === "err" ? "var(--err)" : undefined }}>
                      {routeLabel(h.link)}{lat && <> · <span className="mono">{lat}</span></>} · <span className="mono">{h.deviceId}</span>
                    </div>
                  </div>
                </div>
                <div className="peer-actions">
                  {canSwitchMachines() && <button type="button" className="m-btn m-btn--sm" onClick={() => switchMachine(h.id)}>Switch</button>}
                  <button type="button" className="m-btn m-btn--quiet m-btn--sm" onClick={() => reconnectMachine(h.id)}>Reconnect</button>
                  <button type="button" className="m-btn m-btn--danger m-btn--sm" onClick={() => void forget(h)}>Forget</button>
                </div>
              </div>
              <Text value={h.alias ?? ""} onChange={(v) => void rename(h.id, v)} placeholder={`Show as… (${h.name})`} />
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 18 }}>
        <button type="button" className="m-btn m-btn--accent" onClick={openConnectSheet}><PlusIcon />Connect a machine…</button>
      </div>
    </>
  );
}
