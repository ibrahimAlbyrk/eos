// Remote-access panel — the Settings "Remote" tab. A single toggle that arms the
// iOS relay edge (relay v3) plus the pairing QR the phone scans in the Eos iOS
// app. Relay-only reach: the daemon dials a self-hosted relay, so a real relay
// URL is required before remote can arm (there is no default). The toggle drives
// the manager flow end to end: setRemoteConfig (persist config.remote) → armRemote
// (reload + reconcile the edge live) → pairRemote (mint the v3 QR). OFF disarms.
//
// Custom Component (no registry `groups`), like ModelSettings — so its one default
// (the relay URL, empty) is merged into SETTING_DEFAULTS explicitly below.

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api/client.js";
import { CONTROLS } from "./controls.jsx";

// The Remote tab owns no daemon-settings.json keys (config.remote lives in
// config.json), so this is only the UI-side prefill for the relay URL field.
export const REMOTE_SETTING_DEFAULTS = {};

const Toggle = CONTROLS.toggle;
const Text = CONTROLS.text;

// Cheap client-side guard mirroring the daemon's z.string().url() on relay.url:
// enabling with a blank/invalid URL would 400/409, so gate the toggle instead.
function isValidUrl(u) {
  if (!u) return false;
  try { new URL(u); return true; } catch { return false; }
}

export function RemoteSettings() {
  const [relayUrl, setRelayUrl] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [qr, setQr] = useState(null); // the v3 pair payload object, or null
  const loaded = useRef(false);

  // On mount: reflect the current enabled/armed state and prefill the URL field
  // from the PERSISTED config (status echoes relayUrl) — armed or not, so a
  // disarmed boot doesn't present an empty field that reads as "URL wiped".
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api.getRemoteStatus()
      .then(async (s) => {
        setArmed(!!s?.armed);
        if (s?.relayUrl) setRelayUrl(s.relayUrl);
        // Already armed (an enabled config auto-arms on daemon boot), so no toggle
        // round-trip happens: fetch the QR now, otherwise the panel shows "Armed"
        // with no QR below it.
        if (s?.armed) {
          try {
            const pairRes = await api.pairRemote();
            if (pairRes.ok) setQr(pairRes.body);
          } catch { /* leave QR unfetched; toggling off/on will retry */ }
        }
      })
      .catch(() => {});
  }, []);

  // enabled=true → save config.remote, arm the edge, mint the QR. enabled=false →
  // save disabled, disarm (arm() rebuilds for the now-disabled config), clear QR.
  const apply = async (enabled) => {
    setError(null);
    if (enabled && !isValidUrl(relayUrl)) {
      setError("Enter a valid relay URL (wss://…) before enabling remote access.");
      return;
    }
    setBusy(true);
    try {
      // Disabling writes { enabled:false } ONLY — never the relay block — so the
      // persisted URL can't be clobbered (and an empty field can't 400 the save).
      const saved = await api.setRemoteConfig(enabled ? { enabled, relay: { url: relayUrl } } : { enabled });
      if (!saved.ok) { setError(saved.body?.error ?? `save failed (HTTP ${saved.status})`); return; }

      const armRes = await api.armRemote();
      if (!armRes.ok) { setError(armRes.body?.error ?? `arm failed (HTTP ${armRes.status})`); return; }
      setArmed(!!armRes.body?.armed);

      if (!enabled) { setQr(null); return; }

      const pairRes = await api.pairRemote();
      if (!pairRes.ok) { setError(pairRes.body?.error ?? `pairing failed (HTTP ${pairRes.status})`); return; }
      setQr(pairRes.body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Regenerate: re-mint the QR against the already-armed room (new display window).
  const regenerate = async () => {
    setError(null);
    setBusy(true);
    try {
      const pairRes = await api.pairRemote();
      if (!pairRes.ok) { setError(pairRes.body?.error ?? `pairing failed (HTTP ${pairRes.status})`); return; }
      setQr(pairRes.body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="stg-title">Remote</h2>

      <div className="stg-group">
        <div className="stg-group__title">iOS remote access</div>

        {/* Relay URL — relay-only reach needs a real endpoint, kept editable but
            secondary (below the toggle in importance). Committed on blur/Enter. */}
        <div className="stg-row stg-row--stack">
          <div className="stg-row__text">
            <div className="stg-row__label">Relay URL</div>
            <div className="stg-row__desc">
              The public <code>wss://</code> relay the desktop and phone both dial. Required — remote stays off until it is set.
            </div>
          </div>
          <Text
            value={relayUrl}
            onChange={setRelayUrl}
            placeholder="wss://relay.example.com/"
          />
        </div>

        {/* Enable toggle — drives setRemoteConfig → armRemote → pairRemote. */}
        <div className="stg-row">
          <div className="stg-row__text">
            <div className="stg-row__label">Enable remote access</div>
            <div className="stg-row__desc">
              {armed ? "Armed — scan the QR below to connect." : "Off. Anyone with the QR can drive this desktop, so treat it like a password."}
            </div>
          </div>
          <Toggle value={armed} onChange={(v) => { if (!busy) apply(v); }} />
        </div>

        {error && <div className="stg-prov-err" style={{ marginTop: 4 }}>{error}</div>}
      </div>

      {/* QR + status — only once armed with a minted payload. */}
      {armed && qr && (
        <div className="stg-group">
          <div className="stg-group__title">Pairing QR</div>
          <div className="stg-row stg-row--stack" style={{ alignItems: "center", gap: 14 }}>
            <div style={{ padding: 12, background: "#fff", borderRadius: 12 }}>
              <QRCodeSVG value={JSON.stringify(qr)} size={188} level="M" marginSize={0} />
            </div>
            <div className="stg-row__desc" style={{ textAlign: "center" }}>
              Scan this in the Eos iOS app to pair your phone. Regenerate if the code expires before you scan it.
            </div>
            <button type="button" className="stg-prov-save" disabled={busy} onClick={regenerate}>
              {busy ? "Working…" : "Regenerate QR"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
