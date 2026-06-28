// A focused CodeMirror JSON editor for the inspector's JSON-Schema / JSON-literal
// fields (outputSchema, argsSchema, port schema, init, subGraph args). It REUSES
// the app's shipped CodeMirror 6 stack — the same @codemirror packages and the
// shared fvSyntaxHighlight theme the Code view's EditView uses — rather than a
// form-builder, per the plan (§9.7: JSON-Schema fields are text + validate). The
// validation itself is the pure jsonText module; this is just the view that drives
// it. Lazy-imported by the Inspector so CodeMirror never enters the main bundle.
import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { fvSyntaxHighlight } from "../../../lib/cmHighlight.js";

export default function JsonCodeEditor({ value = "", onChange, onBlur, placeholder = "", minHeight = 80 }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;

  // Build the editor once; the doc is then kept in sync with `value` below.
  useEffect(() => {
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        json(),
        fvSyntaxHighlight,
        EditorView.lineWrapping,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        cmPlaceholder(placeholder),
        EditorView.theme({ "&": { minHeight: `${minHeight}px` }, ".cm-content": { minHeight: `${minHeight}px` } }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({ blur: () => { onBlurRef.current?.(); } }),
      ],
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value → editor: replace the doc only when it actually diverges, so a
  // user keystroke (which already updated the doc) never causes a cursor-resetting
  // round-trip.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value ?? "" } });
    }
  }, [value]);

  return <div className="wfe-cm fv-editor" ref={hostRef} />;
}
