// Checklist · Choice · Form · Actions.

import { useEffect, useRef, useState } from "react";
import { useView } from "../../runtime/ViewContext.jsx";
import { attrText, parseOptions, splitIds, splitLabels } from "../../../../../../contracts/src/genui/attrs.ts";
import { ActionButton } from "../content/ActionButton.jsx";
import { Icon } from "../icons.jsx";
import { Markdown } from "../content/Markdown.jsx";
import { applyLens, itemId, itemName } from "../data/util.js";
import { optionIndex } from "./controls.jsx";

function bindOf(attrs) {
  return typeof attrs.bind === "string" && attrs.bind ? attrs.bind : null;
}

// ── Checklist ───────────────────────────────────────────────────────────────

// Rows of a checklist: from of= items (id, text=, done: true seeds a tick) or
// items= labels.
export function checklistItems(view, attrs) {
  if (typeof attrs.of === "string") {
    return applyLens(view.collection(attrs.of), attrs, view.state).map((it, i) => ({
      id: itemId(it, i),
      label: attrs.text !== undefined ? view.template(attrText(attrs.text), it) : (typeof it.label === "string" && it.label) || itemName(it),
      done: it.done === true,
    }));
  }
  return splitLabels(attrs.items).map((label) => ({ id: label, label, done: false }));
}

// The ticked ids: the stored list, else the items marked done.
export function checkedIds(stored, items) {
  if (Array.isArray(stored)) return new Set(stored.map(String));
  return new Set(items.filter((i) => i.done).map((i) => i.id));
}

export function Checklist({ attrs = {} }) {
  const view = useView();
  const bind = bindOf(attrs);
  if (!bind) return null;
  const items = checklistItems(view, attrs);
  if (!items.length) return null;
  const checked = checkedIds(view.getState(bind, undefined), items);
  const toggle = (id) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    view.setState(bind, items.map((i) => i.id).filter((x) => next.has(x)));
  };
  const done = items.filter((i) => checked.has(i.id)).length;
  const title = view.template(attrText(attrs.title), undefined);
  return (
    <div className="gv-check">
      <div className="gv-check__head">
        {title ? <span className="gv-check__title">{title}</span> : <span />}
        <span className="gv-check__count" aria-label={`${done} of ${items.length} done`}>
          {done} / {items.length}
        </span>
      </div>
      <ul className="gv-check__list">
        {items.map((it) => {
          const on = checked.has(it.id);
          return (
            <li key={it.id} className={on ? "is-done" : undefined}>
              <label className="gv-check__item">
                <input type="checkbox" checked={on} onChange={() => toggle(it.id)} />
                <span>{it.label}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Choice ──────────────────────────────────────────────────────────────────

// answer= names the right option by label (or value), else by 0-based index.
export function answerIndex(options, answer) {
  if (answer === undefined || answer === null || answer === "") return -1;
  const s = String(answer).trim();
  const byLabel = optionIndex(options, s);
  if (byLabel >= 0) return byLabel;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < options.length ? n : -1;
  }
  return -1;
}

// How each option reads once something is picked: right / wrong / picked.
export function choiceMarks(options, pickedIndex, rightIndex) {
  const revealed = pickedIndex >= 0 && rightIndex >= 0;
  return options.map((_, i) => {
    if (revealed && i === rightIndex) return "right";
    if (revealed && i === pickedIndex) return "wrong";
    if (!revealed && i === pickedIndex) return "picked";
    return "";
  });
}

export function Choice({ attrs = {}, node, children }) {
  const view = useView();
  const bind = bindOf(attrs);
  const options = parseOptions(attrs.options);
  if (!bind || !options.length) return null;
  const picked = optionIndex(options, view.getState(bind, null));
  const right = answerIndex(options, attrs.answer);
  const quiz = right >= 0;
  const marks = choiceMarks(options, picked, right);
  const locked = quiz && picked >= 0;
  const question = view.template(attrText(attrs.question), undefined) || (typeof node?.text === "string" ? node.text : typeof children === "string" ? children : "");
  const explain = view.template(attrText(attrs.explain), undefined);
  const action = typeof attrs.action === "string" ? attrs.action : null;
  const pick = (i) => {
    if (locked) return;
    view.setState(bind, options[i].value);
    // The pick is sent with the action — not the state from before this click.
    if (action && view.actions?.[action]) void view.runAction(action, { state: { [bind]: options[i].value } });
  };
  const isRight = quiz && picked === right;
  return (
    <div className="gv-choice" role="group" aria-label={question || undefined}>
      {quiz ? <div className="gv-choice__kicker">Quick check</div> : null}
      {question ? <Markdown text={question} className="gv-choice__q" /> : null}
      <div className="gv-choice__opts">
        {options.map((o, i) => (
          <button
            type="button"
            key={i}
            className={`gv-choice__opt${marks[i] ? ` is-${marks[i]}` : ""}`}
            aria-pressed={picked === i}
            aria-disabled={locked || undefined}
            onClick={() => pick(i)}
          >
            <span className="gv-choice__mark" aria-hidden="true">
              {marks[i] === "right" ? "✓" : marks[i] === "wrong" ? "×" : ""}
            </span>
            <span>{o.label}</span>
            {marks[i] === "right" ? <span className="gv-sr"> (correct)</span> : marks[i] === "wrong" ? <span className="gv-sr"> (your answer, incorrect)</span> : null}
          </button>
        ))}
      </div>
      {locked ? (
        <div className={`gv-choice__feedback ${isRight ? "is-right" : "is-wrong"}`} role="status">
          <b>{isRight ? "Correct." : "Not quite."}</b>
          {explain ? ` ${explain}` : ""}
          <button type="button" className="gv-choice__again" onClick={() => view.setState(bind, null)}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── Form ────────────────────────────────────────────────────────────────────

// Sends the form's action; the runtime adds the view state (every bound field)
// to the message. → {phase: "sent"} or {phase: "error", reason}.
export async function submitForm(view, id) {
  let r;
  try {
    r = await view.runAction(id);
  } catch (err) {
    r = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return r?.ok === false ? { phase: "error", reason: r.reason ?? "Couldn't send" } : { phase: "sent", reason: "" };
}

export function Form({ attrs = {}, children }) {
  const view = useView();
  const [status, setStatus] = useState({ phase: "idle", reason: "" });
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const id = typeof attrs.action === "string" ? attrs.action : null;
  const action = id ? view.actions?.[id] : null;
  const label = view.template(attrText(attrs.submit), undefined) || action?.label || "Send";
  const submit = async (e) => {
    e.preventDefault();
    if (!id || status.phase === "sending" || view.streaming) return;
    setStatus({ phase: "sending", reason: "" });
    const next = await submitForm(view, id);
    setStatus(next);
    if (next.phase === "sent") {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus({ phase: "idle", reason: "" }), 2400);
    }
  };
  return (
    <form className="gv-form" onSubmit={submit} noValidate>
      <div className="gv-form__fields">{children}</div>
      <div className="gv-form__foot">
        {status.phase === "error" ? (
          <span className="gv-form__note is-error" role="alert">
            {status.reason}
          </span>
        ) : null}
        <button type="submit" className="gv-btn gv-btn-primary" disabled={!action || status.phase === "sending"} aria-disabled={view.streaming || undefined}>
          {status.phase === "sent" ? <Icon name="check" size={14} stroke={2.2} /> : null}
          <span>{status.phase === "sent" ? "Sent" : label}</span>
        </button>
      </div>
    </form>
  );
}

// ── Actions ─────────────────────────────────────────────────────────────────

// Which buttons get the tone fill: primary actions, at most two.
export function actionVariants(ids, actions) {
  let primaries = 0;
  return ids.map((id) => {
    const a = actions?.[id];
    if (a?.primary === true && primaries < 2) {
      primaries++;
      return "primary";
    }
    return a?.kind === "set" ? "ghost" : "glass";
  });
}

export function Actions({ attrs = {} }) {
  const view = useView();
  const ids = splitIds(attrs.ids).filter((id) => view.actions?.[id]);
  if (!ids.length) return null;
  const align = ["start", "end", "stretch"].includes(attrs.align) ? attrs.align : "start";
  const variants = actionVariants(ids, view.actions);
  return (
    <div className={`gv-actbar gv-actbar--${align}`}>
      {ids.map((id, i) => (
        <ActionButton key={id} id={id} variant={variants[i] === "primary" ? "primary" : "glass"} className={variants[i] === "ghost" ? "gv-kbtn-ghost" : undefined} />
      ))}
    </div>
  );
}
