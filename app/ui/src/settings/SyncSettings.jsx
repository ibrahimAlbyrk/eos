// Settings › Sync — the user's profile, memories, pages, templates and worker
// definitions on every Mac holding the same sync key. One Mac creates the key; the
// others paste it. The key is the account, so it is copied, never shown.

import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useSyncStatus, refreshSync, setSyncStatus } from "../state/syncStore.js";
import { isRemoteView } from "../lib/host.js";
import { timeAgo } from "../lib/timeAgo.js";
import { CopyIcon } from "../components/machines/icons.jsx";

const LABELS = { memory: ["memory", "memories"], page: ["page", "pages"], template: ["template", "templates"], worker: ["worker", "workers"] };

function countsLine(counts) {
  return Object.entries(LABELS)
    .filter(([k]) => counts?.[k])
    .map(([k, [one, many]]) => `${counts[k]} ${counts[k] === 1 ? one : many}`)
    .join(" · ");
}

function StatusPill({ status }) {
  if (status.phase === "syncing") return <span className="m-pill">Syncing…</span>;
  if (status.phase === "error") return <span className="m-pill m-pill--warn">Can't reach the relay</span>;
  return <span className="m-pill m-pill--ok">Synced {timeAgo(status.lastSyncAt)}</span>;
}

export function SyncSettings() {
  const status = useSyncStatus();
  const [joinKey, setJoinKey] = useState("");
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { void refreshSync(); }, []);

  if (isRemoteView()) {
    return (
      <>
        <h2 className="stg-title">Sync</h2>
        <div className="stg-row__desc">Sync is set up on each computer. Switch to it with ⌃1 to change this Mac's.</div>
      </>
    );
  }

  const run = async (call) => {
    setError(null);
    const r = await call().catch((e) => ({ ok: false, body: { error: e instanceof Error ? e.message : String(e) } }));
    if (!r.ok) { setError(r.body?.error ?? "Something went wrong"); return; }
    setSyncStatus(r.body);
  };
  const copyKey = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(await api.getSyncKey());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const leave = () => {
    if (!window.confirm("Stop syncing this Mac? Its data stays as it is; other Macs keep syncing.")) return;
    void run(() => api.leaveSync());
  };

  const on = status && status.phase !== "off";

  return (
    <>
      <h2 className="stg-title">Sync</h2>
      <div className="peer-hero">
        <div className="peer-hero__text">
          <span className="peer-hero__title">Your profile, memories, pages, templates and workers on every Mac</span>
          <span className="peer-hero__desc">Encrypted on this Mac before it leaves — the relay stores only what it can't read. A Mac that was off catches up when it wakes.</span>
        </div>
        {on && <StatusPill status={status} />}
      </div>
      {error && <div className="stg-prov-err" style={{ marginTop: 10 }}>{error}</div>}
      {on && status.phase === "error" && status.error && <div className="stg-row__desc" style={{ marginTop: 8 }}>{status.error}</div>}

      {status && !on && (
        <div className="stg-group" style={{ marginTop: 26 }}>
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Start syncing</div>
              <div className="stg-row__desc">Makes a sync key for this Mac's data. Paste it on your other Macs.</div>
            </div>
            <button type="button" className="m-btn m-btn--accent" onClick={() => void run(() => api.createSync())}>Create sync key</button>
          </div>
          <div className="stg-row stg-row--stack">
            <div className="stg-row__text">
              <div className="stg-row__label">Join with a key</div>
              <div className="stg-row__desc">From another Mac's Settings › Sync. Where both have something, that Mac's version wins; this Mac's is kept aside.</div>
            </div>
            <div className="peer-invite-row">
              <div className="stg-input" style={{ flex: 1 }}>
                <input type="password" value={joinKey} placeholder="eos-sync1.…" spellCheck={false} autoComplete="off" onChange={(e) => setJoinKey(e.target.value)} />
              </div>
              <button type="button" className="m-btn" disabled={!joinKey.trim()} onClick={() => void run(() => api.joinSync(joinKey.trim()))}>Join</button>
            </div>
          </div>
        </div>
      )}

      {on && (
        <div className="stg-group" style={{ marginTop: 26 }}>
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Sync key</div>
              <div className="stg-row__desc">Paste it on your other Macs. Anyone with it can read and change your synced data — keep it like a password.</div>
            </div>
            <button type="button" className="m-btn m-btn--accent" onClick={() => void copyKey()}><CopyIcon />{copied ? "Copied" : "Copy key"}</button>
          </div>
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Relay</div>
              <div className="stg-row__desc">
                <span className="mono">{status.relay}</span>
                {countsLine(status.counts) && <> · {countsLine(status.counts)}</>}
              </div>
            </div>
            <div className="peer-actions">
              <button type="button" className="m-btn m-btn--sm" disabled={status.phase === "syncing"} onClick={() => void api.syncNow()}>Sync now</button>
              <button type="button" className="m-btn m-btn--danger m-btn--sm" onClick={leave}>Leave</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
