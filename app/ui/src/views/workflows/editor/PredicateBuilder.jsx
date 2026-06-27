// The structured predicate builder (branch.predicate, loop.until). Composes a
// predicate from the closed op set — NEVER a free string — over the pure
// predicateModel ops. Recursive: an and/or clause is itself a PredicateBuilder, so
// nested boolean composition just works. Refs use the binding-ref control with
// upstream-id autocomplete.
import { Segmented, BindingRef, TextInput, Field } from "./inspectorControls.jsx";
import {
  PREDICATE_OPS, RIGHT_MODES, defaultPredicate, changeOp, withLeft, withRef,
  rightMode, withRightMode, withRightValue, literalText, addClause, removeClause, replaceClause,
} from "./predicateModel.js";

const OP_LABELS = { eq: "equals", exists: "exists", and: "all of", or: "any of" };
const RIGHT_LABELS = { truthy: "is truthy", ref: "= ref", literal: "= value" };

export function PredicateBuilder({ value, onChange, suggestions = [], path = "p", depth = 0 }) {
  const pred = value || defaultPredicate();
  const opOptions = PREDICATE_OPS.map((op) => ({ value: op, label: OP_LABELS[op] }));

  return (
    <div className={"wfe-pred" + (depth > 0 ? " wfe-pred--nested" : "")}>
      <Segmented value={pred.op} options={opOptions} onChange={(op) => onChange(changeOp(pred, op))} />

      {pred.op === "eq" && (
        <div className="wfe-pred__rows">
          <BindingRef
            value={pred.left}
            onChange={(v) => onChange(withLeft(pred, v))}
            suggestions={suggestions}
            listId={`${path}-left`}
            placeholder="left ref {{…}}"
          />
          <Segmented
            value={rightMode(pred)}
            options={RIGHT_MODES.map((m) => ({ value: m, label: RIGHT_LABELS[m] }))}
            onChange={(m) => onChange(withRightMode(pred, m))}
          />
          {rightMode(pred) === "ref" && (
            <BindingRef
              value={pred.right}
              onChange={(v) => onChange(withRightValue(pred, v, "ref"))}
              suggestions={suggestions}
              listId={`${path}-right`}
              placeholder="right ref {{…}}"
            />
          )}
          {rightMode(pred) === "literal" && (
            <TextInput
              value={literalText(pred.right)}
              onChange={(v) => onChange(withRightValue(pred, v, "literal"))}
              placeholder="value (true / 42 / text)"
              mono
            />
          )}
        </div>
      )}

      {pred.op === "exists" && (
        <BindingRef
          value={pred.ref}
          onChange={(v) => onChange(withRef(pred, v))}
          suggestions={suggestions}
          listId={`${path}-ref`}
          placeholder="ref {{…}}"
        />
      )}

      {(pred.op === "and" || pred.op === "or") && (
        <div className="wfe-pred__clauses">
          {pred.clauses.map((clause, i) => (
            <div className="wfe-pred__clause" key={`${path}-c${i}`}>
              <PredicateBuilder
                value={clause}
                onChange={(c) => onChange(replaceClause(pred, i, c))}
                suggestions={suggestions}
                path={`${path}-c${i}`}
                depth={depth + 1}
              />
              <button type="button" className="wfe-mini-btn wfe-mini-btn--danger" onClick={() => onChange(removeClause(pred, i))}>
                remove clause
              </button>
            </div>
          ))}
          <button type="button" className="wfe-mini-btn" onClick={() => onChange(addClause(pred))}>+ clause</button>
        </div>
      )}
    </div>
  );
}

// A labeled predicate field (used by the inspector for branch.predicate / loop.until).
export function PredicateField({ label, required, value, onChange, suggestions, path }) {
  return (
    <Field label={label} required={required}>
      <PredicateBuilder value={value} onChange={onChange} suggestions={suggestions} path={path} />
    </Field>
  );
}
