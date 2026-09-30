import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { useHosts, closeConnectSheet, refreshHosts, switchMachine, canSwitchMachines } from "../../state/hostsStore.js";
import { readInvite } from "../../lib/peerInvite.js";
import { refreshPeer } from "../../state/peerStore.js";
import { CONTROLS } from "../../settings/controls.jsx";
import { MachineGlyph } from "./MachineGlyph.jsx";
import { CheckIcon, CloseIcon, CloudIcon, LanIcon, LockIcon } from "./icons.jsx";

// "Connect a machine": paste the invite the other Mac made (Settings › Remote
// access › Invite a device). The preview names the computer and its Device ID
// before anything is sent; the daemon then proves that same identity over the
// wire before it hands over the one-time secret. "Control this Mac too" makes
// the same pairing work both ways.
const Toggle = CONTROLS.toggle;

export function ConnectMachineSheet() {
  const { connectOpen } = useHosts();
  const [link, setLink] = useState("");
  const [alias, setAlias] = useState("");
  const [mutual, setMutual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!connectOpen) { setLink(""); setAlias(""); setMutual(false); setError(null); setBusy(false); return; }
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeConnectSheet(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { cancelAnimationFrame(id); window.removeEventListener("keydown", onKey, true); };
  }, [connectOpen]);

  const preview = useMemo(() => readInvite(link), [link]);
  if (!connectOpen) return null;
  const ready = preview && !preview.error && !busy;

  const connect = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.connectHost(link.trim(), alias.trim() || undefined, mutual);
      if (!r.ok) { setError(r.body?.error ?? `Couldn't connect (${r.status})`); return; }
      if (mutual) void refreshPeer();
      await refreshHosts();
      closeConnectSheet();
      if (canSwitchMachines()) switchMachine(r.body.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stg-overlay" onMouseDown={closeConnectSheet}>
      <div className="connect-sheet glass-pop" role="dialog" aria-modal="true" aria-label="Connect a machine" onMouseDown={(e) => e.stopPropagation()}>
        <div className="connect-sheet__intro">
          <h2 className="stg-title" style={{ margin: 0 }}>Connect a machine</h2>
          <p className="connect-sheet__desc">On the other computer open Settings › Remote access › Invite a computer, then paste the link here.</p>
        </div>

        <div>
          <label className="connect-sheet__label" htmlFor="peer-invite">Invite link</label>
          <div className="peer-field">
            <input
              id="peer-invite"
              ref={inputRef}
              className="mono"
              value={link}
              onChange={(e) => { setLink(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
              placeholder="eos://pair/…"
              spellCheck={false}
              autoComplete="off"
            />
            {preview && !preview.error && <span style={{ color: "var(--ok)", display: "inline-flex" }}><CheckIcon /></span>}
          </div>
          {preview?.error && <div className="connect-sheet__err" style={{ marginTop: 8 }}>{preview.error}</div>}
        </div>

        {preview && !preview.error && (
          <div className="connect-preview">
            <div className="connect-preview__head">
              <MachineGlyph name={preview.name} tone={null} size="xl" />
              <div className="peer-hero__text">
                <span className="peer-hero__title">{preview.name}</span>
                <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-dim)" }}>{preview.deviceId}</span>
              </div>
            </div>
            <div className="connect-preview__pills">
              {preview.direct && <span className="m-pill"><LanIcon size={12} />Direct on its network</span>}
              {preview.relay && <span className="m-pill"><CloudIcon size={12} />Relay</span>}
              <span className="m-pill"><LockIcon size={12} />End-to-end encrypted</span>
            </div>
          </div>
        )}

        {preview && !preview.error && (
          <div>
            <label className="connect-sheet__label" htmlFor="peer-alias">Show it as</label>
            <div className="peer-field">
              <input id="peer-alias" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={preview.name} maxLength={64} />
            </div>
          </div>
        )}

        {preview && !preview.error && (
          <div className="connect-sheet__mutual">
            <div className="connect-sheet__intro">
              <span className="connect-sheet__label" style={{ margin: 0 }}>Let {preview.name} control this Mac too</span>
              <span className="connect-sheet__desc">Turns on Remote access here. Revoke it any time in Settings › Remote access.</span>
            </div>
            <Toggle value={mutual} onChange={setMutual} />
          </div>
        )}

        {error && <div className="connect-sheet__err">{error}</div>}

        <div className="connect-sheet__foot">
          <span className="connect-sheet__note">You'll control agents, terminals and files on that computer.</span>
          <button type="button" className="m-btn" onClick={closeConnectSheet}>Cancel</button>
          <button type="button" className="m-btn m-btn--accent" disabled={!ready} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>

        <button type="button" className="stg-close" title="Close (Esc)" onClick={closeConnectSheet}><CloseIcon /></button>
      </div>
    </div>
  );
}
