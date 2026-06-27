// The worker self-loop sub-form (worker.config.loop = SpawnLoop). A collapsible
// "Self-loop" section: a structured goal (summary + checkable criteria), the
// goal-check strategy (a SELECTOR over LoopStrategySchema — command/judge/hybrid),
// and an attempt limit (number; empty ⇒ unbounded). Mirrors the contract
// SpawnLoopSchema so the emitted value validates on save.
import { Field, TextInput, TextArea, Segmented, NumberInput } from "./inspectorControls.jsx";
import { LOOP_STRATEGIES } from "./nodeConfigSchemas.js";

function nextCriterionId(criteria) {
  let max = 0;
  for (const c of criteria) {
    const m = /(\d+)$/.exec(c.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${max + 1}`;
}

const emptyLoop = () => ({ goal: { summary: "", criteria: [{ id: "c1", text: "" }] } });

export function SpawnLoopForm({ value, onChange }) {
  const enabled = Boolean(value);

  if (!enabled) {
    return (
      <Field label="Self-loop">
        <button type="button" className="wfe-mini-btn" onClick={() => onChange(emptyLoop())}>
          + arm a self-loop
        </button>
      </Field>
    );
  }

  const goal = value.goal || { summary: "", criteria: [] };
  const criteria = goal.criteria || [];
  const setGoal = (patch) => onChange({ ...value, goal: { ...goal, ...patch } });
  const setCriterion = (i, patch) =>
    setGoal({ criteria: criteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });

  return (
    <div className="wfe-subform">
      <div className="wfe-subform__head">
        <span className="wfe-field__label">Self-loop</span>
        <button type="button" className="wfe-mini-btn wfe-mini-btn--danger" onClick={() => onChange(undefined)}>disable</button>
      </div>

      <Field label="Goal summary" required>
        <TextArea value={goal.summary} onChange={(v) => setGoal({ summary: v })} rows={2} placeholder="What 'done' looks like…" />
      </Field>

      <div className="wfe-field__label">Criteria</div>
      {criteria.map((c, i) => (
        <div className="wfe-crit" key={c.id || i}>
          <div className="wfe-crit__row">
            <TextInput value={c.id} onChange={(v) => setCriterion(i, { id: v })} placeholder="id" mono />
            <button
              type="button"
              className="wfe-mini-btn wfe-mini-btn--danger"
              onClick={() => setGoal({ criteria: criteria.filter((_, idx) => idx !== i) })}
            >×</button>
          </div>
          <TextInput value={c.text} onChange={(v) => setCriterion(i, { text: v })} placeholder="criterion text" />
          <TextInput
            value={c.verify || ""}
            onChange={(v) => setCriterion(i, { verify: v || undefined })}
            placeholder="verify command (optional)"
            mono
          />
        </div>
      ))}
      <button
        type="button"
        className="wfe-mini-btn"
        onClick={() => setGoal({ criteria: [...criteria, { id: nextCriterionId(criteria), text: "" }] })}
      >+ criterion</button>

      <Field label="Strategy">
        <Segmented
          value={value.strategy}
          options={LOOP_STRATEGIES}
          onChange={(v) => onChange({ ...value, strategy: v })}
          clearable
        />
      </Field>

      <Field label="Limit (attempts)" help="empty ⇒ unbounded">
        <NumberInput value={value.limit ?? undefined} min={1} onChange={(v) => onChange({ ...value, limit: v })} />
      </Field>
    </div>
  );
}
