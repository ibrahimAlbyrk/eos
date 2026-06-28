// A JSON text field for the inspector — the CodeMirror editor (lazy) + the pure
// jsonText validator. It owns the editor TEXT; it commits the parsed VALUE up to
// config only when the text is valid, and surfaces the parse/shape error otherwise
// (so a half-typed schema never corrupts the saved graph). `mode` picks the
// validator: "schema" requires a well-formed JSON-Schema object, "literal" accepts
// any JSON.
//
// An optional `validator(parsedValue)` adds an ADVISORY check on the committed
// value (used to flag subGraph args that don't match the target workflow's
// argsSchema): its message shows inline as a WARNING but never blocks the commit —
// the value is valid JSON; only the cross-reference is off. On blur, valid JSON is
// pretty-printed in place.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Field } from "./inspectorControls.jsx";
import { parseJson, validateJsonSchema, formatJson } from "./jsonText.js";

const JsonCodeEditor = lazy(() => import("./JsonCodeEditor.jsx"));

const validate = (text, mode) => (mode === "schema" ? validateJsonSchema(text) : parseJson(text));

export function JsonField({ label, required, value, onChange, mode = "literal", help, minHeight = 90, validator }) {
  const [text, setText] = useState(() => formatJson(value));
  const [error, setError] = useState(null); // hard error — blocks the commit
  const [warning, setWarning] = useState(null); // advisory — shown, never blocks
  const lastEmitted = useRef(formatJson(value));

  const advise = (res) => (validator && res.ok && res.value !== undefined ? validator(res.value) : null);

  // Resync the editor when the stored value changes from OUTSIDE this field (undo,
  // node reselect) — but not when the change is the one we just emitted (avoids a
  // reformat-on-keystroke loop).
  useEffect(() => {
    const incoming = formatJson(value);
    if (incoming !== lastEmitted.current) {
      setText(incoming);
      lastEmitted.current = incoming;
      setError(null);
      setWarning(null);
    }
  }, [value]);

  // The advisory may change without the text changing — e.g. the subGraph target
  // switched, so a new argsSchema now applies. Re-run it whenever `validator`
  // identity changes so the flag tracks the target.
  useEffect(() => {
    const res = parseJson(text);
    setWarning(res.ok ? advise(res) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validator]);

  const onText = (t) => {
    setText(t);
    const res = validate(t, mode);
    if (res.ok) {
      setError(null);
      setWarning(advise(res));
      lastEmitted.current = formatJson(res.value);
      onChange(res.value);
    } else {
      setError(res.error);
      setWarning(null);
    }
  };

  // Format-on-blur: pretty-print whatever currently parses as JSON (independent of
  // schema-shape validity — formatting is a syntax concern).
  const onBlur = () => {
    const res = parseJson(text);
    if (res.ok && res.value !== undefined) {
      const pretty = formatJson(res.value);
      if (pretty !== text) setText(pretty);
    }
  };

  return (
    <Field label={label} required={required} help={help} error={error} warn={warning}>
      <Suspense fallback={<div className="wfe-cm wfe-cm--loading">Loading editor…</div>}>
        <JsonCodeEditor value={text} onChange={onText} onBlur={onBlur} minHeight={minHeight} placeholder={mode === "schema" ? '{ "type": "object" }' : "JSON value"} />
      </Suspense>
    </Field>
  );
}
