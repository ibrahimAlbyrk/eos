// The structured schema row builder (worker outputSchema + graph argsSchema),
// wrapped in the Form|JSON HybridField. Each row is { field name, type, required };
// the type is a Select over the closed SCHEMA_FIELD_TYPES vocab, so the builder
// cannot emit an invalid schema. Rows live in local state (so a half-typed,
// not-yet-named field persists) and commit to the JSON Schema through rowsToSchema;
// an external value change (reselect) reseeds them.
import { useEffect, useRef, useState } from "react";
import { Select, TextInput } from "./inspectorControls.jsx";
import { HybridField } from "./HybridField.jsx";
import {
  SCHEMA_FIELD_TYPES, schemaToRows, rowsToSchema, isRepresentableSchema,
  describeNonRepresentable, addRow, removeRow, updateRow,
} from "./schemaRowsModel.js";

const TYPE_OPTIONS = SCHEMA_FIELD_TYPES.map((t) => ({ value: t, label: t }));
const stable = (v) => (v === undefined ? "" : JSON.stringify(v));

function SchemaRows({ value, onChange }) {
  const [rows, setRows] = useState(() => schemaToRows(value));
  const lastSeen = useRef(stable(value));

  useEffect(() => {
    const s = stable(value);
    if (s !== lastSeen.current) {
      lastSeen.current = s;
      setRows(schemaToRows(value));
    }
  }, [value]);

  const commit = (nextRows) => {
    setRows(nextRows);
    const schema = rowsToSchema(nextRows);
    lastSeen.current = stable(schema);
    onChange(schema);
  };

  return (
    <div className="wfe-rows">
      {rows.map((row, i) => (
        <div className="wfe-rows__row" key={i}>
          <TextInput value={row.name} onChange={(v) => commit(updateRow(rows, i, { name: v }))} placeholder="field name" mono />
          <Select value={row.type} options={TYPE_OPTIONS} onChange={(v) => commit(updateRow(rows, i, { type: v || "string" }))} allowEmpty={false} />
          <label className="wfe-rows__req" title="required">
            <input type="checkbox" checked={Boolean(row.required)} onChange={(e) => commit(updateRow(rows, i, { required: e.target.checked }))} />
            req
          </label>
          <button type="button" className="wfe-mini-btn wfe-mini-btn--danger" onClick={() => commit(removeRow(rows, i))}>×</button>
        </div>
      ))}
      <button type="button" className="wfe-mini-btn" onClick={() => commit(addRow(rows))}>+ field</button>
    </div>
  );
}

export function SchemaHybridField({ label, required, help, value, onChange }) {
  return (
    <HybridField
      label={label}
      required={required}
      help={help}
      value={value}
      onChange={onChange}
      jsonMode="schema"
      isRepresentable={isRepresentableSchema}
      describeRaw={describeNonRepresentable}
      renderForm={(p) => <SchemaRows {...p} />}
    />
  );
}
