// Settings › Remote access — who may control THIS Mac from another computer
// (Eos ↔ Eos peering), plus the iPhone section. Off by default. Turning it on
// starts a listener that accepts only paired devices; pairing is a single-use
// invite link made here and pasted on the other computer.

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api/client.js";
import { CONTROLS } from "./controls.jsx";
import { usePeer, refreshPeer } from "../state/peerStore.js";
import { isRemoteView } from "../lib/host.js";
import { MachineGlyph } from "../components/machines/MachineGlyph.jsx";
import { CopyIcon, LinkIcon, QrIcon } from "../components/machines/icons.jsx";
import { RemoteSettings } from "./RemoteSettings.jsx";
import { timeAgo } from "../lib/timeAgo.js";

const Toggle = CONTROLS.toggle;
const Text = CONTROLS.text;

function Invite({ deviceId, openInvites }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  const make = async () => {
    setError(null);
    const r = await api.createInvite().catch(() => null);
    if (!r?.ok) { setError(r?.body?.error ?? "Couldn't make an invite"); return; }
    setInvite(r.body);
    setCopied(false);
    void refreshPeer();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(invite.link); setCopied(true); } catch { setCopied(false); }
  };
  const cancelAll = async () => {
    await api.cancelInvites().catch(() => {});
    setInvite(null);
    void refreshPeer();
  };

  return (
    <div className="stg-row stg-row--stack">
      <div className="stg-row__desc" style={{ marginTop: 0 }}>
        Paste the link into Eos on the other computer (Machines › Connect a machine) — now or days later. It works once; treat it like a password until it's used.
      </div>
      {!invite ? (
        <div>
          <button type="button" className="m-btn m-btn--accent" onClick={() => void make()}><LinkIcon />Make an invite link</button>
        </div>
      ) : (
        <>
          <div className="peer-invite-row">
            <div className="peer-field" style={{ flex: 1 }}>
              <LinkIcon />
              <span className="peer-field__text mono">{invite.link}</span>
            </div>
            <button type="button" className="m-btn m-btn--accent" onClick={() => void copy()}><CopyIcon />{copied ? "Copied" : "Copy link"}</button>
            <button type="button" className={"m-btn" + (showQr ? " m-btn--quiet" : "")} aria-label="Show QR code" aria-pressed={showQr} onClick={() => setShowQr((v) => !v)}><QrIcon /></button>
          </div>
          <div className="peer-invite-meta">
            <span className="m-pill">Works once · no expiry</span>
            <span>The other computer checks this Mac's ID</span>
            <span className="mono" style={{ color: "var(--fg-dim)" }}>{deviceId}</span>
            <button type="button" className="m-btn m-btn--quiet m-btn--sm" style={{ marginLeft: "auto" }} onClick={() => void make()}>New link</button>
          </div>
          {showQr && (
            <div className="peer-qr"><QRCodeSVG value={invite.link} size={168} level="M" marginSize={0} /></div>
          )}
        </>
      )}
      {openInvites > 0 && (
        <div className="peer-invite-meta">
          <span>{openInvites === 1 ? "1 invite link is" : `${openInvites} invite links are`} still open — each works until it's used.</span>
          <button type="button" className="m-btn m-btn--danger m-btn--sm" style={{ marginLeft: "auto" }} onClick={() => void cancelAll()}>Cancel open links</button>
        </div>
      )}
      {error && <div className="stg-prov-err">{error}</div>}
    </div>
  );
}

function Devices({ devices }) {
  const [now] = useState(Date.now());
  const disconnect = async (fp) => { await api.disconnectDevice(fp).catch(() => {}); void refreshPeer(); };
  const revoke = async (d) => {
    if (!window.confirm(`Revoke ${d.name}? It will have to pair again to control this Mac.`)) return;
    await api.revokeDevice(d.fp).catch(() => {});
    void refreshPeer();
  };
  if (devices.length === 0) {
    return <div className="stg-row"><div className="stg-row__desc" style={{ marginTop: 0 }}>No computer is paired yet.</div></div>;
  }
  return devices.map((d) => (
    <div className="stg-row" key={d.fp} style={{ padding: "12px 0" }}>
      <div className="peer-device">
        <MachineGlyph name={d.name} platform={d.platform} tone={d.connected ? "ok" : "off"} size="lg" />
        <div className="stg-row__text">
          <div className="stg-row__label">{d.name}</div>
          <div className="stg-row__desc" style={{ marginTop: 1 }}>
            {d.connected ? "Connected now" : `Paired · last seen ${timeAgo(d.lastSeenAt, now)}`} · <span className="mono">{d.deviceId}</span>
          </div>
        </div>
      </div>
      <div className="peer-actions">
        {d.connected && <button type="button" className="m-btn m-btn--sm" onClick={() => void disconnect(d.fp)}>Disconnect</button>}
        <button type="button" className="m-btn m-btn--danger m-btn--sm" onClick={() => void revoke(d)}>Revoke</button>
      </div>
    </div>
  ));
}

export function RemoteAccessSettings() {
  const { status } = usePeer();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void refreshPeer(); }, []);

  if (isRemoteView()) {
    return (
      <>
        <h2 className="stg-title">Remote access</h2>
        <div className="stg-row__desc">Who may control a computer is set on that computer. Switch to it with ⌃1 to change this Mac's.</div>
      </>
    );
  }

  const update = async (patch) => {
    setBusy(true);
    setError(null);
    const r = await api.updatePeer(patch).catch((e) => ({ ok: false, body: { error: e instanceof Error ? e.message : String(e) } }));
    if (!r.ok) setError(r.body?.error ?? "Couldn't save");
    await refreshPeer();
    setBusy(false);
  };

  const host = status?.host;
  const enabled = Boolean(status?.enabled);

  return (
    <>
      <h2 className="stg-title">Remote access</h2>

      <div className="peer-hero">
        <MachineGlyph name={host?.name} platform={host?.platform} tone={enabled ? (status?.listening || !status?.direct ? "ok" : "warn") : "off"} size="xl" />
        <div className="peer-hero__text">
          <span className="peer-hero__title">Allow other computers to control {host?.name ?? "this Mac"}</span>
          <span className="peer-hero__desc">Paired computers get full control of agents, terminals and files. Every connection is end-to-end encrypted. While on, this Mac stays awake on power so it can be reached — the screen still locks.</span>
        </div>
        <Toggle value={enabled} onChange={(v) => { if (!busy) void update({ enabled: v }); }} />
      </div>
      {error && <div className="stg-prov-err" style={{ marginTop: 10 }}>{error}</div>}

      {enabled && (
        <div className="stg-group" style={{ marginTop: 26 }}>
          <div className="stg-group__title">Invite a computer</div>
          <Invite deviceId={host?.deviceId} openInvites={status?.openInvites ?? 0} />
        </div>
      )}

      <div className="stg-group">
        <div className="stg-group__title">Paired computers</div>
        <Devices devices={status?.devices ?? []} />
      </div>

      {enabled && (
        <div className="stg-group">
          <div className="stg-group__title">Reach</div>
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Direct on this network</div>
              <div className="stg-row__desc">
                {status?.direct && status?.listening
                  ? <>Reachable at <span className="mono">{status.addrs.join(", ") || "—"}</span> · the fastest route.</>
                  : status?.direct ? "Couldn't open the port — another app may be using it." : "Off — other computers can't connect directly."}
              </div>
            </div>
            <Toggle value={Boolean(status?.direct)} onChange={(v) => { if (!busy) void update({ direct: v }); }} />
          </div>
          <div className="stg-row stg-row--stack">
            <div className="stg-row" style={{ padding: 0, borderTop: "none" }}>
              <div className="stg-row__text">
                <div className="stg-row__label">Relay</div>
                <div className="stg-row__desc">For connections from outside this network. It only forwards encrypted bytes — it can't read them.</div>
              </div>
              {status?.relay
                ? <span className={"m-pill" + (status.relay.online ? " m-pill--ok" : " m-pill--warn")}>{status.relay.online ? "Online" : "Connecting…"}</span>
                : <span className="m-pill">Not set</span>}
            </div>
            <Text value={status?.relay?.url ?? ""} onChange={(v) => { const url = v.trim(); if (url && url !== status?.relay?.url) void update({ relayUrl: url }); }} placeholder="wss://relay.example.com/" />
          </div>
          <div className="stg-row stg-row--stack">
            <div className="stg-row__text">
              <div className="stg-row__label">Name</div>
              <div className="stg-row__desc">How this Mac appears on other computers.</div>
            </div>
            <Text value={host?.name ?? ""} onChange={(v) => { if (v.trim() && v.trim() !== host?.name) void update({ name: v.trim() }); }} placeholder="This Mac" />
          </div>
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Device ID</div>
              <div className="stg-row__desc">Other computers confirm this when they pair.</div>
            </div>
            <span className="mono" style={{ fontSize: "var(--text-sm)", color: "var(--fg-mid)" }}>{host?.deviceId}</span>
          </div>
        </div>
      )}

      <div className="stg-group">
        <div className="stg-group__title">iPhone</div>
        <RemoteSettings embedded />
      </div>
    </>
  );
}
