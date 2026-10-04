import { useState } from "react";
import { CONTROLS } from "../../settings/controls.jsx";
import { ProfileAvatar } from "./ProfileAvatar.jsx";
import { saveProfile } from "../../state/profileStore.js";
import { mergeProfilePatch } from "../../lib/profileText.js";
import {
  INTERVIEW_STEPS, REPLY_SAMPLES, answersToPatch, canContinue, cardLines, initialAnswers,
} from "../../lib/profileInterview.js";
import {
  AUTONOMY_OPTIONS, CHAT_LANGUAGE_OPTIONS, LANGUAGE_OPTIONS, REPLY_OPTIONS, ROLE_OPTIONS,
} from "../../lib/profileOptions.js";
import { ArrowIcon, CheckIcon } from "../accounts/icons.jsx";

const Chips = CONTROLS.chips;
const Tags = CONTROLS.tags;

function Field({ label, children }) {
  return (
    <div className="intv-field">
      <span className="acc-eyebrow">{label}</span>
      {children}
    </div>
  );
}

// One body per step — each edits only its own answers.
function StepBody({ step, a, set }) {
  if (step === "name") {
    return (
      <div className="intv-inputs">
        <label className="intv-input">Full name
          <input value={a.fullName} autoFocus placeholder="Your name" onChange={(e) => set({ fullName: e.target.value })} />
        </label>
        <label className="intv-input">Call me
          <input value={a.callName} placeholder="First name or nickname" onChange={(e) => set({ callName: e.target.value })} />
        </label>
      </div>
    );
  }
  if (step === "work") {
    return (
      <>
        <Field label="Role"><Chips value={a.roles} onChange={(v) => set({ roles: v })} options={ROLE_OPTIONS} multiple /></Field>
        <Field label="Stack"><Tags value={a.stack} onChange={(v) => set({ stack: v })} placeholder="Add — e.g. TypeScript" /></Field>
      </>
    );
  }
  if (step === "language") {
    return (
      <>
        <Field label="Talk to me in"><Chips value={a.chat} onChange={(v) => set({ chat: v })} options={CHAT_LANGUAGE_OPTIONS} /></Field>
        <Field label="Code, commits & docs in"><Chips value={a.code} onChange={(v) => set({ code: v })} options={LANGUAGE_OPTIONS} /></Field>
      </>
    );
  }
  return (
    <>
      <div className="intv-replies" role="radiogroup" aria-label="Reply style">
        {REPLY_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={a.replies === o.value}
            className={`intv-reply${a.replies === o.value ? " is-on" : ""}`}
            onClick={() => set({ replies: o.value })}
          >
            <b>{o.label}</b>
            <span className="intv-reply__sample">{REPLY_SAMPLES[o.value]}</span>
          </button>
        ))}
      </div>
      <Field label="When to check with you"><Chips value={a.autonomy} onChange={(v) => set({ autonomy: v })} options={AUTONOMY_OPTIONS} /></Field>
    </>
  );
}

// First-run profile interview: one question per screen on the left, the profile
// every agent will read filling in live on the right. One save at the end.
export function ProfileInterview({ profile, onClose, onSkip, onOpenProfile }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState(() => initialAnswers(profile));
  const [done, setDone] = useState(false);
  const set = (patch) => setAnswers((a) => ({ ...a, ...patch }));
  const step = INTERVIEW_STEPS[index];
  const last = index === INTERVIEW_STEPS.length - 1;
  const ok = canContinue(step.id, answers);
  const preview = mergeProfilePatch(profile, answersToPatch(answers, null));

  const next = () => {
    if (!ok) return;
    if (!last) { setIndex(index + 1); return; }
    void saveProfile(answersToPatch(answers, Date.now()));
    setDone(true);
  };

  return (
    <div className="acc-welcome intv" role="dialog" aria-modal="true" aria-label="Set up your profile">
      <div className="acc-welcome__drag" aria-hidden="true" />
      <section className="intv__main" onKeyDown={(e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && !e.target.closest(".stg-tags")) next(); }}>
        <header className="intv__top">
          <div className="acc-welcome__brand"><span className="acc-welcome__mark" />eos</div>
          <span className="intv__label">Profile setup</span>
          <span className="intv__progress" aria-label={`Step ${Math.min(index + 1, INTERVIEW_STEPS.length)} of ${INTERVIEW_STEPS.length}`}>
            {INTERVIEW_STEPS.map((s, i) => <span key={s.id} className={`intv__seg${done || i <= index ? " is-on" : ""}`} />)}
          </span>
          {!done && <button type="button" className="acc-link acc-link--quiet" onClick={onSkip}>Skip for now</button>}
        </header>

        {done ? (
          <div className="intv__question" key="done">
            <span className="intv__done"><CheckIcon size={20} /></span>
            <h1>You're set{answers.callName.trim() ? `, ${answers.callName.trim()}` : ""}.</h1>
            <p>Every new agent starts knowing this. Change anything later in Settings › Profile.</p>
            <div className="intv__actions">
              <button type="button" className="acc-btn acc-btn--outline acc-btn--tall" onClick={onOpenProfile}>Open profile</button>
              <button type="button" className="acc-btn acc-btn--primary acc-btn--tall" onClick={onClose}>Start working<ArrowIcon size={15} /></button>
            </div>
          </div>
        ) : (
          <>
            <div className="intv__question" key={step.id}>
              <h1>{step.title}</h1>
              <p>{step.sub}</p>
              <div className="intv__body"><StepBody step={step.id} a={answers} set={set} /></div>
            </div>
            <footer className="intv__actions">
              <button type="button" className="acc-btn acc-btn--outline acc-btn--tall" disabled={index === 0} onClick={() => setIndex(index - 1)}>Back</button>
              <button type="button" className="acc-btn acc-btn--primary acc-btn--tall" disabled={!ok} onClick={next}>
                {last ? "Finish" : "Continue"}<ArrowIcon size={15} />
              </button>
            </footer>
          </>
        )}
      </section>

      <aside className="intv__side">
        <div className="intv-card">
          <div className="intv-card__head">
            <ProfileAvatar profile={preview} size={54} />
            <span className="intv-card__who">
              <b>{answers.fullName.trim() || answers.callName.trim() || "You"}</b>
              <span>What every agent reads first</span>
            </span>
          </div>
          <div className="intv-card__lines">
            {cardLines(answers, done ? INTERVIEW_STEPS.length : index).map((l) => (
              <div key={l.label} className={`intv-card__line${l.current && !done ? " is-current" : ""}`}>
                <span className="acc-eyebrow">{l.label}</span>
                {l.filled ? <span className="intv-card__value">{l.value}</span> : <span className="intv-card__skel" />}
              </div>
            ))}
          </div>
        </div>
        <p className="intv__note">Edit or delete any of it later. It only leaves this Mac inside your agents' prompts.</p>
      </aside>
    </div>
  );
}
