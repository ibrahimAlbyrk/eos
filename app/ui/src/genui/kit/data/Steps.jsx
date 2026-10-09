import { useState } from "react";
import { useView } from "../../runtime/ViewContext.jsx";
import { Icon } from "../icons.jsx";
import { elementChildren } from "../layout/layout.jsx";
import { attrText } from "../../../../../../contracts/src/genui/attrs.ts";
import { applyLens, itemId, itemName } from "./util.js";
import { stepDots, stepFlags, stepNav, clampStep } from "./stepsLogic.js";

function text(v) {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

// Steps from of= rows (title/text/code templates), or one per child element
// (its label= or title= names it).
export function stepsOf(view, attrs, children) {
  if (typeof attrs.of === "string") {
    const items = applyLens(view.collection(attrs.of), attrs, view.state);
    const pick = (attr, it, fallback) => (attrs[attr] !== undefined ? view.template(attrText(attrs[attr]), it) : fallback);
    return items.map((it, i) => ({
      key: itemId(it, i),
      title: pick("title", it, itemName(it)),
      text: pick("text", it, text(it.text ?? it.note)),
      code: pick("code", it, text(it.code)),
      content: null,
    }));
  }
  // Child elements only: the renderer puts text runs between them as GvText.
  return elementChildren(children).map((content, i) => {
    const a = content?.props?.node?.attrs ?? content?.props?.attrs ?? {};
    return { key: String(i), title: attrText(a.label ?? a.title), text: "", code: "", content };
  });
}

const Chevron = ({ dir }) => <Icon name={dir < 0 ? "chevron-left" : "chevron-right"} size={15} stroke={2} />;

export function Steps({ attrs = {}, children }) {
  const view = useView();
  const steps = stepsOf(view, attrs, children);
  const bind = typeof attrs.bind === "string" ? attrs.bind : null;
  const [local, setLocal] = useState(0);
  const total = steps.length;
  const index = clampStep(bind ? view.getState(bind, 0) : local, total);
  const go = (i) => {
    const next = clampStep(i, total);
    if (bind) view.setState(bind, next);
    else setLocal(next);
  };
  if (!total) return null;

  if (attrs.variant !== "stepper") {
    return (
      <ol className="gv-steps gv-steps--list">
        {steps.map((s, i) => {
          const current = bind ? i === index : false;
          return (
            <li className={`gv-steps__item${current ? " is-current" : ""}`} key={s.key} aria-current={current ? "step" : undefined}>
              <span className="gv-steps__n" aria-hidden="true">
                {i + 1}
              </span>
              <div className="gv-steps__body">
                {s.title ? (
                  bind ? (
                    <button type="button" className="gv-steps__title gv-steps__title--btn" onClick={() => go(i)}>
                      {s.title}
                    </button>
                  ) : (
                    <div className="gv-steps__title">{s.title}</div>
                  )
                ) : null}
                {s.text ? <div className="gv-steps__text">{s.text}</div> : null}
                {s.content}
                {s.code ? <code className="gv-steps__code">{s.code}</code> : null}
              </div>
            </li>
          );
        })}
      </ol>
    );
  }

  const step = steps[index];
  const flags = stepFlags(index, total);
  const onKey = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(stepNav(index, total, 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(stepNav(index, total, -1));
    }
  };
  return (
    <div className="gv-steps gv-steps--stepper" role="group" aria-roledescription="stepper" tabIndex={0} onKeyDown={onKey}>
      {step.content ? <div className="gv-steps__stage">{step.content}</div> : null}
      <div className="gv-steps__cap">
        <div className="gv-steps__copy" aria-live="polite">
          <div className="gv-steps__count">{flags.label}</div>
          {step.title ? <div className="gv-steps__title">{step.title}</div> : null}
          {step.text ? <div className="gv-steps__text">{step.text}</div> : null}
        </div>
        <div className="gv-steps__nav">
          <button type="button" className="gv-btn gv-btn-secondary gv-kbtn-icon" aria-label="Previous step" disabled={flags.atStart} onClick={() => go(stepNav(index, total, -1))}>
            <Chevron dir={-1} />
          </button>
          <button type="button" className="gv-btn gv-btn-primary" disabled={flags.atEnd} onClick={() => go(stepNav(index, total, 1))}>
            Next
            <Chevron dir={1} />
          </button>
        </div>
      </div>
      <div className="gv-steps__foot">
        <div className="gv-steps__dots">
          {stepDots(index, total).map((d, k) => (
            <button
              type="button"
              key={k}
              className={`gv-steps__dot${d.current ? " is-current" : ""}${d.done ? " is-done" : ""}`}
              aria-label={`Go to step ${k + 1}`}
              aria-current={d.current ? "step" : undefined}
              onClick={() => go(k)}
            />
          ))}
        </div>
        {step.code ? <code className="gv-steps__code">{step.code}</code> : null}
      </div>
    </div>
  );
}
