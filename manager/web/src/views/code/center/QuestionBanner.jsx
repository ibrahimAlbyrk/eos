import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../../../api/client.js";


export function QuestionBanner({ questions, workerId, toolUseId, pendingCount, onClose }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selections, setSelections] = useState(() => new Map());
  const [otherTexts, setOtherTexts] = useState(() => new Map());
  const [submitting, setSubmitting] = useState(false);
  const otherInputRef = useRef(null);

  const total = questions.length;
  const q = questions[currentIndex];

  const multi = !!q?.multiSelect;
  const options = q?.options ?? [];
  const otherIndex = options.length;
  const sel = selections.get(currentIndex) ?? new Set();
  const otherText = otherTexts.get(currentIndex) ?? "";
  const otherSelected = sel.has(otherIndex);

  const toggleOption = useCallback((idx) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const cur = new Set(next.get(currentIndex) ?? []);
      if (multi) {
        if (cur.has(idx)) cur.delete(idx); else cur.add(idx);
      } else {
        cur.clear();
        cur.add(idx);
      }
      next.set(currentIndex, cur);
      return next;
    });
  }, [currentIndex, multi]);

  const updateOtherText = useCallback((text) => {
    setOtherTexts((prev) => {
      const next = new Map(prev);
      next.set(currentIndex, text);
      return next;
    });
  }, [currentIndex]);

  const hasAnswer = sel.size > 0 && (!otherSelected || otherText.trim().length > 0);
  const isLast = currentIndex === total - 1;

  const submitAll = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Fast-path: a single-question banner that is the ONLY pending question
      // for this worker can answer via a raw numeric keystroke into the TUI.
      // With more than one pending (concurrent subagents) keystrokes are
      // ambiguous, so always resolve the daemon long-poll deterministically.
      if (total === 1 && pendingCount === 1) {
        const s = selections.get(0) ?? new Set();
        const picked = [...s][0];
        const oIdx = (questions[0]?.options ?? []).length;
        if (picked != null && picked !== oIdx) {
          await api.sendKeystroke(workerId, String(picked + 1));
          return;
        }
      }
      const answers = {};
      for (let qi = 0; qi < total; qi++) {
        const s = selections.get(qi) ?? new Set();
        const qObj = questions[qi];
        const opts = qObj?.options ?? [];
        const oIdx = opts.length;
        const oText = (otherTexts.get(qi) ?? "").trim();
        let answer;
        if (s.has(oIdx) && oText) {
          answer = oText;
        } else if (qObj.multiSelect) {
          answer = [...s].sort().filter(i => i !== oIdx).map(i => opts[i]?.label).filter(Boolean).join(", ");
        } else {
          const picked = [...s][0];
          answer = opts[picked]?.label ?? "";
        }
        answers[qObj.header ?? qObj.question] = answer;
      }
      await api.answerQuestion(workerId, toolUseId, answers);
    } finally {
      setSubmitting(false);
      onClose();
    }
  }, [total, pendingCount, selections, otherTexts, questions, workerId, toolUseId, submitting, onClose]);

  const handleNext = useCallback(() => {
    if (!hasAnswer) return;
    if (isLast) submitAll();
    else setCurrentIndex((i) => i + 1);
  }, [hasAnswer, isLast, submitAll]);

  const handleBack = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }, [currentIndex]);

  useEffect(() => {
    const handler = (e) => {
      if (submitting) return;
      if (e.metaKey && e.key === "Enter") {
        e.preventDefault();
        handleNext();
        return;
      }
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= options.length + 1) {
        e.preventDefault();
        toggleOption(num - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [options.length, toggleOption, handleNext, submitting]);

  useEffect(() => {
    if (otherSelected && otherInputRef.current) otherInputRef.current.focus();
  }, [otherSelected]);

  if (!q) return null;

  return (
    <div className="q-banner">
      <div className="q-card">
        <div className="q-header">
          <span className="q-step">{currentIndex + 1}/{total}</span>
          {q.header && <span className="q-chip">{q.header}</span>}
          <span className="q-question">{q.question}</span>
          <button className="q-close" onClick={onClose} title="Close">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="q-options">
          {options.map((opt, i) => {
            const selected = sel.has(i);
            return (
              <div key={i} className={"q-option" + (selected ? " q-selected" : "")} onClick={() => toggleOption(i)}>
                <span className="q-indicator">
                  {multi ? (selected ? <CheckIcon /> : <UncheckedIcon />) : (selected ? <RadioOnIcon /> : <RadioOffIcon />)}
                </span>
                <div className="q-opt-body">
                  <span className="q-opt-label">{opt.label}</span>
                  {opt.description && <span className="q-opt-desc">{opt.description}</span>}
                </div>
                <span className="q-num-badge">{i + 1}</span>
              </div>
            );
          })}
          <div className={"q-option" + (otherSelected ? " q-selected" : "")} onClick={() => toggleOption(otherIndex)}>
            <span className="q-indicator">
              {multi ? (otherSelected ? <CheckIcon /> : <UncheckedIcon />) : (otherSelected ? <RadioOnIcon /> : <RadioOffIcon />)}
            </span>
            <div className="q-opt-body">
              <span className="q-opt-label">Other</span>
              {otherSelected && (
                <input
                  ref={otherInputRef}
                  className="q-other-input"
                  type="text"
                  placeholder="Type your own answer here"
                  value={otherText}
                  onChange={(e) => updateOtherText(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleNext(); } }}
                />
              )}
            </div>
            <span className="q-num-badge">{otherIndex + 1}</span>
          </div>
        </div>

        <div className="q-actions">
          <div className="q-left">
            {currentIndex > 0 && (
              <button className="q-btn q-back" onClick={handleBack} disabled={submitting}>Back</button>
            )}
          </div>
          <div className="q-right">
            <button className="q-btn q-skip" onClick={onClose} disabled={submitting}>Skip</button>
            <button
              className={"q-btn q-next" + (hasAnswer ? " q-primary" : "")}
              onClick={handleNext}
              disabled={submitting || !hasAnswer}
            >
              {submitting ? "Sending…" : (isLast ? "Submit" : "Next")}{" "}
              {!submitting && <span className="q-shortcut">⌘↵</span>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RadioOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#666" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
    </svg>
  );
}
function RadioOnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="#c8a2ff" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="3.5" fill="#c8a2ff" />
    </svg>
  );
}
function UncheckedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#666" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="2" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="12" height="12" rx="2" fill="#c8a2ff" />
      <path d="M5 8l2.5 2.5L11 6" stroke="#1a1a1a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
