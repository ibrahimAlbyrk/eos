import { useEffect, useRef, useState } from "react";
import { editField, loadVersion, usePages, versionKey } from "../../../../state/eos/pageStore.js";
import { Revert } from "./Revert.jsx";
import { editableFields, textProblem } from "./pageFields.js";

// One text field: kept as typed, sent when the reader leaves it.
function TextField({ field, original, onSet }) {
  const [text, setText] = useState(field.value);
  useEffect(() => setText(field.value), [field.value]);
  const problem = textProblem(field, text);
  const id = `page-field-${field.path}`;
  const leave = () => {
    if (!problem && text !== field.value) onSet(field.path, text);
  };
  const Input = field.kind === "longtext" ? "textarea" : "input";
  return (
    <div className="eos-edit__field">
      <div className="eos-edit__head">
        <label className="eos-edit__label" htmlFor={id}>{field.label}</label>
        <Revert shown={original != null && field.value !== original} what={field.label.toLowerCase()} onRevert={() => onSet(field.path, original)} />
      </div>
      <Input
        id={id}
        className={field.kind === "longtext" ? "eos-edit__text" : "eos-edit__line"}
        {...(field.kind === "longtext" ? { rows: 5 } : { type: "text" })}
        value={text}
        aria-invalid={problem ? "true" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={leave}
      />
      {problem && <p className="eos-edit__problem" role="alert">{problem}</p>}
    </div>
  );
}

// A list: its rows with Move up, Move down and Remove when the contract lets
// the reader reorder it, and each row's own editable text.
function ListField({ field, originals, onSet, onMove, onRemove }) {
  const canRemove = field.rows.length > field.min;
  return (
    <fieldset className="eos-edit__list">
      <legend className="eos-edit__label">{field.label}</legend>
      {field.rows.map((row, i) => (
        <div key={`${row.index}-${row.label}`} className="eos-edit__row">
          <div className="eos-edit__row-head">
            <span className="eos-edit__row-title">{row.label}</span>
            {field.editable && (
              <span className="eos-actions">
                <button type="button" className="eos-btn eos-btn--quiet" disabled={i === 0} onClick={() => onMove(field.path, i, i - 1)}>Move up</button>
                <button type="button" className="eos-btn eos-btn--quiet" disabled={i === field.rows.length - 1} onClick={() => onMove(field.path, i, i + 1)}>Move down</button>
                <button type="button" className="eos-btn eos-btn--quiet" disabled={!canRemove} onClick={() => onRemove(field.path, i)}>Remove</button>
              </span>
            )}
          </div>
          {row.fields.map((inner) => (
            <TextField key={inner.path} field={inner} original={originals[inner.path]} onSet={onSet} />
          ))}
        </div>
      ))}
    </fieldset>
  );
}

// The page data editor (08 §4.9): the marked fields of a page issue, read
// from the contract of the design the issue was made with. Each change is
// one edit in place on the revision on screen, a new revision the core keeps
// with its before and after.
export function PageDataEditor({ surfaceId, issue, data }) {
  const { versions } = usePages();
  const [error, setError] = useState(null);
  // The values as Eos wrote them, the first time this issue was drawn here.
  const originals = useRef(null);
  useEffect(() => { void loadVersion(surfaceId, issue.version); }, [surfaceId, issue.version]);
  const contract = versions[versionKey(surfaceId, issue.version)]?.body?.contract;
  if (!contract) return null;
  const fields = editableFields(contract, data);
  originals.current ??= Object.fromEntries(
    fields.flatMap((f) => (f.kind === "list" ? f.rows.flatMap((r) => r.fields) : [f])).map((f) => [f.path, f.value]),
  );
  if (!fields.length) return <p className="eos-note">Nothing on this page is marked to edit.</p>;
  const send = async (edit) => {
    const r = await editField(surfaceId, issue.id, { baseRev: issue.rev, ...edit });
    setError(r.ok ? null : r.error);
  };
  return (
    <div className="eos-edit eos-page-edit">
      {fields.map((field) => (field.kind === "list"
        ? (
          <ListField
            key={field.path}
            field={field}
            originals={originals.current}
            onSet={(path, value) => void send({ op: "set", path, value })}
            onMove={(path, from, to) => void send({ op: "move", path, from, to })}
            onRemove={(path, index) => void send({ op: "remove", path, from: index })}
          />
        )
        : <TextField key={field.path} field={field} original={originals.current[field.path]} onSet={(path, value) => void send({ op: "set", path, value })} />))}
      {error && <p className="eos-edit__problem" role="alert">{error}</p>}
    </div>
  );
}
