import { useEffect, useState } from "react";
import {
  checkCapability, enterSecret, forgetSecret, forgetSignIn, installCapabilityHere, loadCapability, removeCapability, rollbackCapability,
  saveCapabilitySettings, setCapabilityEnabled,
  useCapabilities,
} from "../../../state/eos/capabilitiesStore.js";
import { startSignIn } from "../../../state/eos/capabilitySignInStore.js";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { fmtTimeAgo } from "../../../lib/format.js";
import { Dialog, FailedLead, Fact } from "../frame.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { DevRunNote, OfflineNote } from "./parts.jsx";
import { SignInSheet } from "./SignInSheet.jsx";
import { CLASS_MEANING, CLASSES, fixFor, fixLabel, keyFor, setupStep, madeOf, OUTCOMES, signInLabel, signsIn, stateLine, stateTone, stateWord, VERSION_STATUSES, WORKS } from "./words.js";

const LIST = "eos:/capabilities";
const TRASH_ICON = "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5";

// A part of the page: its label (and a quiet aside), a hairline, its content.
function Part({ label, aside, children }) {
  return (
    <section className="eos-cap-part" aria-label={label}>
      <div className="eos-cap-part__head">
        <h2 className="eos-label">{label}</h2>
        {aside !== undefined && <span className="eos-cap-part__aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

// Where it stands, in words: why when it needs a look, who uses it when it works.
function nowLine(detail, routineNames) {
  if (detail.state === "ready") {
    const ids = detail.usedBy ?? [];
    const names = ids.map((id) => routineNames[id]).filter(Boolean);
    if (ids.length === 0) {
      const last = detail.recentCalls?.[0];
      return last?.outcome === "ok" ? `Ready. No routine uses it yet; it last worked ${fmtTimeAgo(last.at)}.` : "Ready. No routine uses it yet.";
    }
    return names.length === ids.length ? `Ready, and ${names.join(", ")} ${names.length === 1 ? "uses" : "use"} it.` : "Ready, and in use.";
  }
  const why = stateLine(detail);
  if (!why) return `${stateWord(detail)}.`;
  // The state's word first, then why: "Needs sign-in: the service no longer accepts its sign-in."
  const first = why.startsWith("Eos ") ? why : why.charAt(0).toLowerCase() + why.slice(1);
  return `${stateWord(detail)}: ${first}`;
}

const RUN_FIX = {
  "sign-in": (detail) => startSignIn(detail.id),
  enable: (detail) => setCapabilityEnabled(detail.id, true),
  check: (detail) => checkCapability(detail.id),
  key: (detail) => enterSecret(detail.id, keyFor(detail)?.name),
};

// The lead, as an object's page leads: how it is made and where it works as
// a label, what it does, where it stands now (its tone's mark in the margin
// when it needs a look), who it is signed in as, and the one thing to do.
function Lead({ detail, names }) {
  const fix = fixFor(detail, "page");
  const step = setupStep(detail);
  const tone = stateTone(detail);
  const marked = tone === "warn" || tone === "err";
  const label = [...madeOf(detail), detail.version && `Version ${detail.version}`, WORKS[detail.works] ?? detail.works].filter(Boolean).join(" · ");
  const account = detail.accountLabel && (detail.id === "slack" ? `Connected to ${detail.accountLabel}` : `Signed in as ${detail.accountLabel}`);
  const signedIn = signsIn(detail) && detail.secrets.some((s) => s.set);
  // No sign-in can start without a client id, so none is offered then.
  const again = signsIn(detail) && fix !== "sign-in" && detail.state !== "available" && detail.stateCode !== "client_id_missing";
  let primary = null;
  if (detail.state === "available") primary = <button type="button" className="eos-btn eos-btn--primary" onClick={() => void installCapabilityHere(detail.id)}>Install on this Mac</button>;
  else if (fix) primary = <button type="button" className="eos-btn eos-btn--primary" onClick={() => void RUN_FIX[fix](detail)}>{fixLabel(detail, fix)}</button>;
  return (
    <header className="eos-rlead eos-cap-lead">
      <p className="eos-label">{label}</p>
      <p className="eos-lead">{detail.summary}</p>
      <p className={marked ? `eos-rlead__now eos-rlead__now--${tone}` : "eos-rlead__now"}>{nowLine(detail, names)}</p>
      {account && <Fact tone={detail.state === "ready" ? "ok" : undefined}>{account}</Fact>}
      {step && <Fact>{step}</Fact>}
      {(primary || again || signedIn) && (
        <div className="eos-rlead__acts">
          {primary}
          {again && <button type="button" className="eos-btn" onClick={() => void startSignIn(detail.id)}>{signedIn ? `${signInLabel(detail)} again` : signInLabel(detail)}</button>}
          {signedIn && <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void forgetSignIn(detail)}>Forget sign-in</button>}
        </div>
      )}
    </header>
  );
}

// The header's quiet moves: those the lead does not already offer.
function HeaderActions({ detail, onRemove }) {
  const fix = fixFor(detail, "page");
  const enabled = detail.state !== "disabled";
  if (detail.state === "available") return <button type="button" className="eos-btn eos-btn--quiet" onClick={onRemove}>Remove</button>;
  return (
    <>
      {fix !== "check" && <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void checkCapability(detail.id)}>Check now</button>}
      {fix !== "enable" && <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void setCapabilityEnabled(detail.id, !enabled)}>{enabled ? "Disable" : "Enable"}</button>}
      {detail.origin !== "builtin" && <button type="button" className="eos-btn eos-btn--quiet" onClick={onRemove}>Remove</button>}
    </>
  );
}

// The action that undoes another, by its summary when the capability lists
// it, else its name in words ("withdraw_review" → "Withdraw review").
function undoWords(actions, name) {
  const named = actions.find((a) => a.name === name)?.summary;
  if (named) return named;
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// What an action counts as, by its mark: reading is hollow, acting solid,
// speaking for the user brighter, what cannot be taken back in warn.
const ACT_MARKS = { read: "", write_local: "acts", tell_user: "acts", speak: "speaks", irreversible: "final" };

function Actions({ actions }) {
  return (
    <ul className="eos-cap-acts">
      {actions.map((a) => (
        <li key={a.name} className={ACT_MARKS[a.class] ? `eos-cap-act eos-cap-act--${ACT_MARKS[a.class]}` : "eos-cap-act"}>
          <span className="eos-cap-act__main">
            <span className="eos-cap-act__name">{a.summary || a.name}</span>
            {a.undo && <span className="eos-cap-act__undo">{undoWords(actions, a.undo)} takes it back</span>}
          </span>
          <span className="eos-cap-act__class">{CLASSES[a.class] ?? a.class}</span>
        </li>
      ))}
    </ul>
  );
}

// A capability that can do one thing says it as a statement, with what its
// class means, rather than as a list of one.
function LoneAction({ action, actions }) {
  const mark = ACT_MARKS[action.class];
  return (
    <div className={mark ? `eos-cap-lone eos-cap-lone--${mark}` : "eos-cap-lone"}>
      <p className="eos-cap-lone__name">{action.summary || action.name}</p>
      <p className="eos-cap-lone__line">
        <span className="eos-cap-lone__class">{CLASSES[action.class] ?? action.class}</span>
        {CLASS_MEANING[action.class] && <> · {CLASS_MEANING[action.class]}</>}
      </p>
      {action.undo && <p className="eos-cap-lone__undo">{undoWords(actions, action.undo)} takes it back.</p>}
    </div>
  );
}

function Reach({ reach }) {
  const parts = [["Websites", reach.hosts], ["Apps", reach.apps], ["Files", reach.files]].filter(([, items]) => items.length > 0);
  if (parts.length === 0) return <p className="eos-cap-quiet">Nothing outside Eos.</p>;
  return (
    <dl className="eos-cap-reach">
      {parts.map(([label, items]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {items.map((item) => (item === "*"
              ? <span key={item} className="eos-cap-place eos-cap-place--any">Any website</span>
              : <span key={item} className="eos-cap-place">{item}</span>))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const CALL_TONES = { ok: "ok", error: "err", denied: "err", timeout: "warn", busy: "warn" };

function Calls({ calls }) {
  return (
    <ul className="eos-cap-calls">
      {calls.map((c, i) => (
        <li key={`${c.at}-${i}`} className={CALL_TONES[c.outcome] ? `eos-cap-call eos-cap-call--${CALL_TONES[c.outcome]}` : "eos-cap-call"}>
          <span className="eos-cap-call__when">{fmtTimeAgo(c.at)}</span>
          <span className="eos-cap-call__action">{c.action}</span>
          <span className="eos-cap-call__outcome">{OUTCOMES[c.outcome] ?? c.outcome}</span>
          <span className="eos-cap-call__ms">{c.durationMs} ms</span>
        </li>
      ))}
    </ul>
  );
}

// Who uses it: each routine by name, opening it; a count until names are read.
function UsedBy({ detail, names }) {
  const ids = detail.usedBy ?? [];
  if (ids.length === 0) {
    // The one next step for a thing nothing uses: a routine that does.
    const say = `Use ${detail.name} to `;
    return (
      <div className="eos-cap-unused">
        <p className="eos-cap-quiet">No routine uses it yet.</p>
        {detail.state === "ready" && (
          <button type="button" className="eos-cap-next" onClick={() => openLocation(buildLocation({ screen: "new-routine", say }))}>
            Make a routine with it <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
    );
  }
  if (!ids.every((id) => names[id])) return <p className="eos-cap-quiet">{ids.length === 1 ? "One routine" : `${ids.length} routines`}</p>;
  return (
    <ul className="eos-cap-facts">
      {ids.map((id) => (
        <li key={id} className="eos-cap-fact">
          <button type="button" className="eos-cap-link" onClick={() => openLocation(buildLocation({ screen: "routine", routineId: id }))}>{names[id]}</button>
        </li>
      ))}
    </ul>
  );
}

// A secret is typed only in the app's own prompt, which these buttons open;
// a sign-in's secret is kept by signing in.
function Secrets({ detail }) {
  const typed = !signsIn(detail);
  // The key the lead asks for is replaced there, not twice.
  const led = fixFor(detail, "page") === "key" ? keyFor(detail)?.name : null;
  return (
    <ul className="eos-cap-facts">
      {detail.secrets.map((s) => (
        <li key={s.name} className="eos-cap-fact">
          <span className="eos-cap-fact__row">
            <span className="eos-cap-fact__name">{s.label}</span>
            <span className={s.set ? "eos-cap-fact__value eos-cap-fact__value--ok" : "eos-cap-fact__value eos-cap-fact__value--warn"}>{s.set ? "Set" : "Missing"}</span>
          </span>
          {typed && (
            <span className="eos-cap-fact__acts">
              {s.name !== led && (
                <button type="button" className={s.set ? "eos-btn eos-btn--quiet" : "eos-btn eos-btn--primary"} onClick={() => void enterSecret(detail.id, s.name)}>
                  {s.set ? `Replace ${s.label}` : `Enter ${s.label}`}
                </button>
              )}
              {s.set && <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void forgetSecret(detail.id, s.name)}>Forget {s.label}</button>}
            </span>
          )}
        </li>
      ))}
    </ul>
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
        <label key={s.name} className="eos-cap-setting">
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
      {/* Save comes once something changed: an idle, greyed Save reads as broken. */}
      {changed && (
        <div className="eos-cap-settings__acts">
          <span className="eos-cap-part__aside">Not saved yet</span>
          <button type="button" className="eos-btn eos-btn--quiet" onClick={() => setValues(saved)}>Cancel</button>
          <button type="submit" className="eos-btn eos-btn--primary">Save settings</button>
        </div>
      )}
    </form>
  );
}

// Its versions, newest first: the one in use lit, a proposed one waiting in
// Needs you, a kept one it can go back to.
function Versions({ detail }) {
  return (
    <ul className="eos-cap-facts">
      {detail.versions.map((v) => {
        const inUse = v.version === detail.version;
        const proposed = v.status === "proposed";
        const word = inUse ? "In use" : VERSION_STATUSES[v.status] ?? v.status;
        const tone = inUse ? " eos-cap-fact__value--ok" : proposed ? " eos-cap-fact__value--active" : "";
        return (
          <li key={v.version} className={inUse ? "eos-cap-fact eos-cap-fact--on" : proposed ? "eos-cap-fact eos-cap-fact--asks" : "eos-cap-fact"}>
            <span className="eos-cap-fact__row">
              <span className="eos-cap-fact__mono">{v.version}</span>
              <span className={`eos-cap-fact__value${tone}`}>{word} · {fmtTimeAgo(v.createdAt)}</span>
            </span>
            {v.status === "installed" && !inUse && (
              <span className="eos-cap-fact__acts">
                <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void rollbackCapability(detail.id, v.version)}>Go back to this version</button>
              </span>
            )}
            {proposed && (
              <span className="eos-cap-fact__acts">
                <button type="button" className="eos-btn eos-btn--quiet" onClick={() => openLocation("eos:/needs")}>It waits in Needs you</button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Asks before it goes to the trash, naming the routines that lose it.
export function RemoveDialog({ detail, names, onClose }) {
  const users = (detail.usedBy ?? []).map((id) => names[id]).filter(Boolean);
  const remove = async () => {
    if (await removeCapability(detail.id)) openLocation(LIST);
    else onClose();
  };
  let line = "It goes to the trash. No routine uses it.";
  if (users.length) line = `It goes to the trash, and ${users.join(", ")} can no longer reach it.`;
  else if ((detail.usedBy ?? []).length) line = "It goes to the trash, and the routines that use it can no longer reach it.";
  return (
    <Dialog
      id="eos-cap-remove"
      from="Capabilities"
      icon={TRASH_ICON}
      title={`Remove ${detail.name}?`}
      line={line}
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="eos-btn eos-btn--quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="eos-btn eos-btn--primary" onClick={() => void remove()}>Remove</button>
        </>
      )}
    />
  );
}

function Detail({ detail, names }) {
  return (
    <>
      <Lead detail={detail} names={names} />
      <div className="eos-cap-cols">
        <div className="eos-cap-main">
          {detail.actions.length === 1 ? (
            <Part label="What it does"><LoneAction action={detail.actions[0]} actions={detail.actions} /></Part>
          ) : (
            <Part label="What it can do" aside={detail.actions.length || undefined}>
              {detail.actions.length ? <Actions actions={detail.actions} /> : <p className="eos-cap-quiet">No actions.</p>}
            </Part>
          )}
          <Part label="What it reaches"><Reach reach={detail.reach} /></Part>
          <Part label="Recent calls" aside={detail.recentCalls.length || undefined}>
            {detail.recentCalls.length ? <Calls calls={detail.recentCalls} /> : <p className="eos-cap-quiet">Not called yet.</p>}
          </Part>
        </div>
        <aside className="eos-cap-aside" aria-label={`About ${detail.name}`}>
          <Part label="Used by"><UsedBy detail={detail} names={names} /></Part>
          {detail.secrets.length > 0 && <Part label={signsIn(detail) ? "Sign-in" : "Secrets"}><Secrets detail={detail} /></Part>}
          {detail.settings.length > 0 && (
            <Part label="Settings">
              <Settings key={detail.settings.map((s) => s.value ?? "").join("\u0000")} detail={detail} />
            </Part>
          )}
          {detail.versions.length > 0 && <Part label="Versions" aside={detail.versions.length}><Versions detail={detail} /></Part>}
        </aside>
      </div>
    </>
  );
}

// A ghost of the page while it is read: a label, then rows on hairlines.
function Ghost() {
  return (
    <div className="eos-skeleton eos-skeleton--rows" aria-busy="true" aria-label="Loading">
      <span className="eos-skeleton__label" />
      {[0, 1, 2].map((i) => <span key={i} className="eos-skeleton__row"><span /><span /></span>)}
    </div>
  );
}

// eos:/capabilities/<id>: what one capability does and reaches, where it
// stands and the one thing that fixes it, who uses it, its secrets, settings
// and versions, and what can be done with it.
export function CapabilityScreen({ id }) {
  const { details, failed, list, devRun } = useCapabilities();
  const { list: routines } = useRoutines();
  const [removing, setRemoving] = useState(false);
  useEffect(() => void loadCapability(id), [id]);
  useEffect(() => ensureRoutinesLoaded(), []);
  const detail = details[id];
  const name = detail?.name ?? list?.find((r) => r.id === id)?.name ?? id;
  const names = Object.fromEntries((routines ?? []).map((r) => [r.id, r.name]));

  let body;
  if (detail) body = <Detail detail={detail} names={names} />;
  else if (failed[id] === "gone") {
    body = (
      <header className="eos-rlead eos-cap-gone">
        <p className="eos-lead">This capability is not here any more.</p>
        <p className="eos-rlead__now">It was removed, or it was never on this Mac.</p>
        <div className="eos-rlead__acts"><button type="button" className="eos-btn" onClick={() => openLocation(LIST)}>All capabilities</button></div>
      </header>
    );
  } else if (failed[id] === "error") body = <FailedLead what="this capability" retry={() => void loadCapability(id)} back={{ label: "Back to Capabilities", location: LIST }} />;
  else body = <Ghost />;

  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Capabilities", location: LIST }, { label: name }]}>
        {detail && <HeaderActions detail={detail} onRemove={() => setRemoving(true)} />}
      </EosHeader>
      <OfflineNote />
      <div className="eos-body">
        {devRun && <DevRunNote />}
        {body}
      </div>
      {removing && detail && <RemoveDialog detail={detail} names={names} onClose={() => setRemoving(false)} />}
      <SignInSheet />
    </main>
  );
}
