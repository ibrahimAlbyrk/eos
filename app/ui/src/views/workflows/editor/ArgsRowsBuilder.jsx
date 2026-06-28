// The subGraph `args` key/value row builder, wrapped in the Form|JSON HybridField.
// Rows are { key, value }; when the target workflow's argsSchema is resolvable the
// rows are prefilled with its keys and the value inputs are typed by it (placeholder
// = expected type, coercion to that type). Rows live in local state so a half-typed
// row persists; they commit through rowsToArgs and reseed on external value change.
import { useEffect, useRef, useState } from "react";
import { TextInput } from "./inspectorControls.jsx";
import { HybridField } from "./HybridField.jsx";
import {
  isRepresentableArgs, describeNonRepresentableArgs, rowsToArgs, initialArgRows,
  coerceArgValue, argValueText, expectedArgType, requiredArgKeys,
  addArgRow, removeArgRow, updateArgRow,
} from "./argsRowsModel.js";

const stable = (v) => (v === undefined ? "" : JSON.stringify(v));

function ArgsRows({ value, onChange, targetSchema }) {
  const [rows, setRows] = useState(() => initialArgRows(value, targetSchema));
  const lastSeen = useRef(stable(value));
  const lastTarget = useRef(stable(targetSchema));

  // External value change (reselect/undo) — reseed rows from the stored args.
  useEffect(() => {
    const s = stable(value);
    if (s !== lastSeen.current) {
      lastSeen.current = s;
      setRows(initialArgRows(value, targetSchema));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Target switched (operator picked another sub-workflow) — re-prefill from the new
  // schema, but only when no args have been entered yet (never clobber typed args).
  useEffect(() => {
    const t = stable(targetSchema);
    if (t !== lastTarget.current) {
      lastTarget.current = t;
      setRows((prev) => (rowsToArgs(prev) === undefined ? initialArgRows(undefined, targetSchema) : prev));
    }
  }, [targetSchema]);

  const commit = (nextRows) => {
    setRows(nextRows);
    const args = rowsToArgs(nextRows);
    lastSeen.current = stable(args);
    onChange(args);
  };

  const required = requiredArgKeys(targetSchema);

  return (
    <div className="wfe-rows">
      {rows.map((row, i) => {
        const type = expectedArgType(targetSchema, row.key);
        const isReq = required.includes(row.key);
        return (
          <div className="wfe-rows__row" key={i}>
            <TextInput value={row.key} onChange={(v) => commit(updateArgRow(rows, i, { key: v }))} placeholder="key" mono />
            <TextInput
              value={argValueText(row.value)}
              onChange={(v) => commit(updateArgRow(rows, i, { value: coerceArgValue(v, type) }))}
              placeholder={type ? type + (isReq ? " *" : "") : "value"}
            />
            <button type="button" className="wfe-mini-btn wfe-mini-btn--danger" onClick={() => commit(removeArgRow(rows, i))}>×</button>
          </div>
        );
      })}
      <button type="button" className="wfe-mini-btn" onClick={() => commit(addArgRow(rows))}>+ arg</button>
    </div>
  );
}

export function ArgsHybridField({ label, required, help, value, onChange, targetSchema, validator }) {
  return (
    <HybridField
      label={label}
      required={required}
      help={help}
      value={value}
      onChange={onChange}
      jsonMode="literal"
      validator={validator}
      isRepresentable={isRepresentableArgs}
      describeRaw={describeNonRepresentableArgs}
      renderForm={(p) => <ArgsRows {...p} targetSchema={targetSchema} />}
    />
  );
}
