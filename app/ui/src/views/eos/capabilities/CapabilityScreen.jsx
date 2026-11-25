import { useEffect, useState } from "react";
import {
  checkCapability, enterSecret, forgetSecret, forgetSignIn, installCapabilityHere, loadCapability, removeCapability, rollbackCapability,
  saveCapabilitySettings, setCapabilityEnabled,
  useCapabilities,
} from "../../../state/eos/capabilitiesStore.js";
import { startSignIn } from "../../../state/eos/capabilitySignInStore.js";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { fmtTimeAgo } from "../../../lib/format.js";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { CapabilityState, DevRunNote, LoadFailed, Loading, OfflineNote } from "./parts.jsx";
import { SignInSheet } from "./SignInSheet.jsx";
import { CLASSES, fixFor, madeOf, OUTCOMES, signInLabel, signsIn, usedBy, VERSION_STATUSES, WORKS } from "./words.js";

const LIST = "eos:/capabilities";

function Section({ label, children }) {
  return (
    <section className="eos-card eos-cap-section">
      <h2 className="eos-label">{label}</h2>
      {children}
    </section>
  );
}

function Controls({ detail }) {
  const { id } = detail;
  const fix = fixFor(detail);
  const cls = (which) => (fix === which ? "eos-btn eos-btn--primary" : "eos-btn");
  const enabled = detail.state !== "disabled";
  const remove = async () => {
    if (await removeCapability(id)) openLocation(LIST);
  };
  if (detail.state === "available") {
    return (
      <div className="eos-actions">
        <button type="button" className="eos-btn eos-btn--primary" onClick={() => void installCapabilityHere(id)}>Install on this Mac</button>
        <button type="button" className="eos-btn" onClick={() => void remove()}>Remove</button>
      </div>
    );
  }
  return (
    <div className="eos-actions">
      {signsIn(detail) && <button type="button" className={cls("sign-in")} onClick={() => void startSignIn(id)}>{signInLabel(detail)}</button>}
      {signsIn(detail) && detail.secrets.some((s) => s.set) && (
        <button type="button" className="eos-btn" onClick={() => void forgetSignIn(detail)}>Forget sign-in</button>
      )}
      <button type="button" className={cls("check")} onClick={() => void checkCapability(id)}>Check now</button>
      <button type="button" className={cls("enable")} onClick={() => void setCapabilityEnabled(id, !enabled)}>{enabled ? "Disable" : "Enable"}</button>
      {detail.origin !== "builtin" && <button type="button" className="eos-btn" onClick={() => void remove()}>Remove</button>}
    </div>
  );
}

// A secret is typed only in the app's own prompt, which these buttons open.
function SecretButtons({ detail }) {
  return (
    <div className="eos-actions">
      {detail.secrets.map((s) => (
        <span key={s.name} className="eos-actions">
          <button type="button" className={s.set ? "eos-btn" : "eos-btn eos-btn--primary"} onClick={() => void enterSecret(detail.id, s.name)}>
            {s.set ? `Replace ${s.label}` : `Enter ${s.label}`}
          </button>
          {s.set && <button type="button" className="eos-btn" onClick={() => void forgetSecret(detail.id, s.name)}>Forget {s.label}</button>}
        </span>
      ))}
    </div>
  );
}

const INPUT_TYPES = { phone: "tel", email: "email" };

// Its settings as the user sets them: a field each (a choice offers its
// choices), saved together.
function Settings({ detail }) {
  const saved = Object.fromEntries(detail.settings.map((s) => [s.name, s.value ?? ""]));
  const [values, setValues] = useState(saved);
  const changed = detail.settings.some((s) => (values[s.name] ?? "") !== saved[s.name]);
  const put = (name, value) => setValues((v) => ({ ...v, [name]: value }));
  return (
    <form className="eos-cap-settings" onSubmit={(e) => { e.preventDefault(); void saveCapabilitySettings(detail.id, values); }}>
      {detail.settings.map((s) => (
        <label key={s.name} className="eos-facts__row">
          <span>{s.label}</span>
          {s.kind === "choice" && s.choices?.length ? (
            <select value={values[s.name] ?? ""} onChange={(e) => put(s.name, e.target.value)}>
              <option value="">Not set</option>
              {s.choices.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input type={INPUT_TYPES[s.kind] ?? "text"} value={values[s.name] ?? ""} placeholder="Not set" onChange={(e) => put(s.name, e.target.value)} />
          )}
        </label>
      ))}
      <div className="eos-actions">
        <button type="submit" className="eos-btn" disabled={!changed}>Save settings</button>
      </div>
    </form>
  );
}

function Actions({ actions }) {
  return (
    <ul className="eos-cap-list">
      {actions.map((a) => (
        <li key={a.name} className="eos-cap-item">
          <span className="eos-cap-item__main">{a.summary || a.name}</span>
          <span className="eos-cap-item__side">{CLASSES[a.class] ?? a.class}{a.undo ? ` · ${a.undo} takes it back` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function Reach({ reach }) {
  const parts = [["Websites", reach.hosts], ["Apps", reach.apps], ["Files", reach.files]].filter(([, items]) => items.length > 0);
  if (parts.length === 0) return <p className="eos-note">Nothing outside Eos.</p>;
  return (
    <dl className="eos-facts">
      {parts.map(([label, items]) => (
        <div key={label} className="eos-facts__row"><dt>{label}</dt><dd>{items.join(", ")}</dd></div>
      ))}
    </dl>
  );
}

function Versions({ detail }) {
  return (
    <ul className="eos-cap-list">
      {detail.versions.map((v) => (
        <li key={v.version} className="eos-cap-item">
          <span className="eos-cap-item__main">Version {v.version}</span>
          <span className="eos-cap-item__side">
            {v.version === detail.version ? "In use" : VERSION_STATUSES[v.status] ?? v.status} · {fmtTimeAgo(v.createdAt)}
          </span>
          {v.status === "installed" && v.version !== detail.version && (
            <button type="button" className="eos-btn" onClick={() => void rollbackCapability(detail.id, v.version)}>Go back to this version</button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Calls({ calls }) {
  return (
    <ul className="eos-cap-list">
      {calls.map((c, i) => (
        <li key={`${c.at}-${i}`} className="eos-cap-item">
          <span className="eos-cap-item__main">{c.action}</span>
          <span className="eos-cap-item__side">{OUTCOMES[c.outcome] ?? c.outcome} · {c.durationMs} ms · {fmtTimeAgo(c.at)}</span>
        </li>
      ))}
    </ul>
  );
}

function Detail({ detail }) {
  const { list: routines } = useRoutines();
  useEffect(() => ensureRoutinesLoaded(), []);
  const names = Object.fromEntries((routines ?? []).map((r) => [r.id, r.name]));
  const facts = [
    ...madeOf(detail),
    detail.version && `Version ${detail.version}`,
    WORKS[detail.works] ?? detail.works,
    usedBy(detail, names),
    detail.accountLabel && (detail.id === "slack" ? `Connected to ${detail.accountLabel}` : `Signed in as ${detail.accountLabel}`),
  ].filter(Boolean);
  return (
    <>
      <section className="eos-card eos-cap-section">
        <p className="eos-cap-summary">{detail.summary}</p>
        <CapabilityState row={detail} />
        <p className="eos-cap-row__facts">{facts.join(" · ")}</p>
        <Controls detail={detail} />
      </section>
      <Section label="What it can do">
        {detail.actions.length ? <Actions actions={detail.actions} /> : <p className="eos-note">No actions.</p>}
      </Section>
      <Section label="What it reaches"><Reach reach={detail.reach} /></Section>
      {detail.secrets.length > 0 && (
        <Section label="Secrets">
          <dl className="eos-facts">
            {detail.secrets.map((s) => (
              <div key={s.name} className="eos-facts__row"><dt>{s.label}</dt><dd>{s.set ? "Set" : "Missing"}</dd></div>
            ))}
          </dl>
          {!signsIn(detail) && <SecretButtons detail={detail} />}
        </Section>
      )}
      {detail.settings.length > 0 && (
        <Section label="Settings">
          <Settings key={detail.settings.map((s) => s.value ?? "").join("\u0000")} detail={detail} />
        </Section>
      )}
      {detail.versions.length > 0 && <Section label="Versions"><Versions detail={detail} /></Section>}
      <Section label="Recent calls">
        {detail.recentCalls.length ? <Calls calls={detail.recentCalls} /> : <p className="eos-note">Not called yet.</p>}
      </Section>
    </>
  );
}

// eos:/capabilities/<id>: what one capability does and reaches, and what can
// be done with it.
export function CapabilityScreen({ id }) {
  const { details, failed, list, devRun } = useCapabilities();
  useEffect(() => void loadCapability(id), [id]);
  const detail = details[id];
  const name = detail?.name ?? list?.find((r) => r.id === id)?.name ?? id;

  let body;
  if (detail) body = <Detail detail={detail} />;
  else if (failed[id] === "gone") body = <p className="eos-note">This capability is not here any more.</p>;
  else if (failed[id] === "error") body = <LoadFailed what="this capability" retry={() => void loadCapability(id)} />;
  else body = <Loading />;

  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Capabilities", location: LIST }, { label: name }]} />
      <OfflineNote />
      <div className="eos-body">
        {devRun && <DevRunNote />}
        {body}
      </div>
      <SignInSheet />
    </main>
  );
}
