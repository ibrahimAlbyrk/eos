// A JSON text field for the inspector — the CodeMirror editor (lazy) + the pure
// jsonText validator. It owns the editor TEXT; it commits the parsed VALUE up to
// config only when the text is valid, and surfaces the parse/shape error otherwise
// (so a half-typed schema never corrupts the saved graph). `mode` picks the
// validator: "schema" requires a JSON object, "literal" accepts any JSON.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Field } from "./inspectorControls.jsx";
import { parseJson, validateJsonSchema, formatJson } from "./jsonText.js";

const JsonCodeEditor = lazy(() => import("./JsonCodeEditor.jsx"));

const validate = (text, mode) => (mode === "schema" ? validateJsonSchema(text) : parseJson(text));

export function JsonField({ label, required, value, onChange, mode = "literal", help, minHeight = 90 }) {
  const [text, setText] = useState(() => formatJson(value));
  const [error, setError] = useState(null);
  const lastEmitted = useRef(formatJson(value));

  // Resync the editor when the stored value changes from OUTSIDE this field (undo,
  // node reselect) — but not when the change is the one we just emitted (avoids a
  // reformat-on-keystroke loop).
  useEffect(() => {
    const incoming = formatJson(value);
    if (incoming !== lastEmitted.current) {
      setText(incoming);
      lastEmitted.current = incoming;
      setError(null);
    }
  }, [value]);

  const onText = (t) => {
    setText(t);
    const res = validate(t, mode);
    if (res.ok) {
      setError(null);
      lastEmitted.current = formatJson(res.value);
      onChange(res.value);
    } else {
      setError(res.error);
    }
  };

  return (
    <Field label={label} required={required} help={help} error={error}>
      <Suspense fallback={<div className="wfe-cm wfe-cm--loading">Loading editor…</div>}>
        <JsonCodeEditor value={text} onChange={onText} minHeight={minHeight} placeholder={mode === "schema" ? '{ "type": "object" }' : "JSON value"} />
      </Suspense>
    </Field>
  );
}
