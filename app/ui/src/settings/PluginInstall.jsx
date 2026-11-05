// Settings › Plugins › Add plugin: install one from npm, a git repository or a
// folder on this Mac. Nothing is installed until the user has seen what was
// fetched (exactly which version, its integrity hash, what it replaces) and said
// yes. Also the installed plugin's own source row: update or remove it.

import { useState } from "react";
import { CONTROLS } from "./controls.jsx";
import { api } from "../api/client.js";
import { refreshPlugins, usePluginInstall } from "../plugins/pluginsStore.js";
import { notify } from "../lib/notify.js";

const errText = (e) => (e instanceof Error ? e.message : String(e));

const KINDS = [
  { value: "npm", label: "npm" },
  { value: "git", label: "Git" },
  { value: "local", label: "Folder" },
];

export function sourceLabel(source) {
  if (source.kind === "npm") return `npm · ${source.name}${source.version ? `@${source.version}` : ""}`;
  if (source.kind === "git") return `git · ${source.url}${source.ref ? `#${source.ref}` : ""}`;
  return `folder · ${source.path}`;
}

const fmtSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

// The answer's `staged`, or an Error with the daemon's reason.
async function staged(request) {
  const r = await request;
  if (!r.ok) throw new Error(r.body?.error ?? `couldn't fetch the plugin (${r.status})`);
  return r.body.staged;
}

function Field({ label, desc, children }) {
  return (
    <div className="stg-row stg-row--stack">
      <div className="stg-row__text">
        <div className="stg-row__label">{label}</div>
        {desc && <div className="stg-row__desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function TextInput({ value, onChange, placeholder }) {
  return (
    <div className="stg-input">
      <input type="text" value={value} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function AddPluginPage({ onBack, onInstalled }) {
  const [kind, setKind] = useState("npm");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [review, setReview] = useState(null);

  const source = kind === "npm"
    ? { kind, name: name.trim(), ...(version.trim() ? { version: version.trim() } : {}) }
    : kind === "git"
      ? { kind, url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) }
      : { kind, path };
  const ready = kind === "npm" ? Boolean(source.name) : kind === "git" ? Boolean(source.url) : Boolean(path);

  const fetchIt = async () => {
    setBusy(true);
    setError(null);
    try {
      setReview(await staged(api.stagePlugin(source)));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    try {
      const r = await api.pickDirectory();
      if (r?.path) setPath(r.path);
    } catch (e) {
      notify.error(errText(e));
    }
  };

  if (review) {
    return (
      <StagedReview
        staged={review}
        onBack={() => setReview(null)}
        onInstalled={(plugin) => onInstalled(plugin.id)}
      />
    );
  }

  return (
    <>
      <BackButton onClick={onBack} />
      <h2 className="stg-title">Add plugin</h2>
      <div className="stg-row__desc plg-intro">
        Eos fetches the plugin and shows you exactly what it got before anything is installed. It never runs install scripts.
      </div>
      <div className="stg-group">
        <div className="stg-row">
          <div className="stg-row__text">
            <div className="stg-row__label">From</div>
          </div>
          <CONTROLS.segmented value={kind} onChange={(v) => { setKind(v); setError(null); }} options={KINDS} />
        </div>
        {kind === "npm" && (
          <>
            <Field label="Package" desc="Its files are used as published — a plugin package carries everything it needs.">
              <TextInput value={name} onChange={setName} placeholder="eos-plugin-clock" />
            </Field>
            <Field label="Version" desc="An exact version or a tag. Empty means the latest.">
              <TextInput value={version} onChange={setVersion} placeholder="latest" />
            </Field>
          </>
        )}
        {kind === "git" && (
          <>
            <Field label="Repository" desc="An https URL. Its hooks and submodules are left out.">
              <TextInput value={url} onChange={setUrl} placeholder="https://github.com/you/eos-plugin-clock" />
            </Field>
            <Field label="Branch or tag" desc="Empty means the default branch.">
              <TextInput value={ref} onChange={setRef} placeholder="main" />
            </Field>
          </>
        )}
        {kind === "local" && (
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Folder</div>
              <div className="stg-row__desc plg-mono">{path || "A folder with a plugin.json — Eos copies it in."}</div>
            </div>
            <button type="button" className="m-btn m-btn--sm" onClick={() => void pick()}>Choose…</button>
          </div>
        )}
      </div>
      {error && <pre className="plg-error">{error}</pre>}
      <div className="plg-actions">
        <button type="button" className="m-btn m-btn--accent" disabled={!ready || busy} onClick={() => void fetchIt()}>
          {busy ? "Fetching…" : "Review"}
        </button>
      </div>
    </>
  );
}

export function StagedReview({ staged: s, onBack, onInstalled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const leave = () => {
    void api.discardStagedPlugin(s.stagingId);
    onBack();
  };
  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.installStagedPlugin(s.stagingId);
      if (!r.ok) throw new Error(r.body?.error ?? `couldn't install (${r.status})`);
      await refreshPlugins();
      onInstalled(r.body.plugin);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const m = s.manifest;
  return (
    <>
      <BackButton onClick={leave} />
      <h2 className="stg-title">Install {m.name}?</h2>
      {m.description && <div className="stg-row__desc plg-intro">{m.description}</div>}
      <div className="plg-trust" role="note">
        A plugin runs inside the Eos window with the same access Eos has: it sees what you see and can act in Eos for you. Install only plugins you trust.
      </div>
      <div className="stg-group">
        <ReviewRow label="Plugin" value={`${m.id}${m.version ? ` · v${m.version}` : ""}`} />
        <ReviewRow label="From" value={sourceLabel(s.source)} />
        {s.source.kind !== "local" && <ReviewRow label="Fetched" value={s.resolved} mono />}
        {s.integrity && <ReviewRow label="Integrity" value={s.integrity} mono />}
        <ReviewRow label="Size" value={`${s.files} file${s.files === 1 ? "" : "s"} · ${fmtSize(s.bytes)}`} />
        {s.replaces && (
          <ReviewRow
            label="Replaces"
            value={s.replaces.installed
              ? `the installed ${m.id}${s.replaces.version ? ` v${s.replaces.version}` : ""}`
              : `the ${m.id} plugin made on this Mac — its folder moves to ~/.eos/plugins/.trash`}
          />
        )}
      </div>
      {error && <pre className="plg-error">{error}</pre>}
      <div className="plg-actions">
        <button type="button" className="m-btn m-btn--accent" disabled={busy} onClick={() => void install()}>{busy ? "Installing…" : "Install"}</button>
        <button type="button" className="m-btn" disabled={busy} onClick={leave}>Cancel</button>
      </div>
    </>
  );
}

function ReviewRow({ label, value, mono }) {
  return (
    <div className="stg-row">
      <div className="stg-row__text">
        <div className="stg-row__label">{label}</div>
        <div className={"stg-row__desc plg-break" + (mono ? " plg-mono" : "")}>{value}</div>
      </div>
    </div>
  );
}

export function BackButton({ onClick, label = "Plugins" }) {
  return (
    <button type="button" className="plg-back" onClick={onClick}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m10 3-5 5 5 5" /></svg>
      {label}
    </button>
  );
}

// On a plugin's own page: where it came from, an update from there, and removing it.
export function PluginSourceRows({ plugin, onReview, onRemoved }) {
  const install = usePluginInstall(plugin.id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const update = async () => {
    setBusy(true);
    try {
      onReview(await staged(api.stagePluginUpdate(plugin.id)));
    } catch (e) {
      notify.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirming) { setConfirming(true); return; }
    setBusy(true);
    try {
      const r = await api.removePlugin(plugin.id);
      if (!r.ok) throw new Error(r.body?.error ?? `couldn't remove ${plugin.id}`);
      await refreshPlugins();
      onRemoved();
    } catch (e) {
      notify.error(errText(e));
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <>
      {install && (
        <div className="stg-row">
          <div className="stg-row__text">
            <div className="stg-row__label">Installed from</div>
            <div className="stg-row__desc plg-mono plg-break">{sourceLabel(install.source)}{install.source.kind === "git" ? ` @ ${install.resolved.slice(0, 10)}` : ""}</div>
          </div>
          <button type="button" className="m-btn m-btn--sm" disabled={busy} onClick={() => void update()}>Check for update</button>
        </div>
      )}
      <div className="stg-row">
        <div className="stg-row__text">
          <div className="stg-row__label">Remove</div>
          <div className="stg-row__desc">Its folder moves to ~/.eos/plugins/.trash; its settings stay, in case it comes back.</div>
        </div>
        <button type="button" className="m-btn m-btn--danger m-btn--sm" disabled={busy} onClick={() => void remove()} onBlur={() => setConfirming(false)}>
          {confirming ? "Remove it" : "Remove"}
        </button>
      </div>
    </>
  );
}
