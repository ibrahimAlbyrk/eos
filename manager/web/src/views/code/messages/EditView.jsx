import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration,
} from "@codemirror/view";
import { indentOnInput, indentUnit, bracketMatching } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { cmLanguageFor } from "../../../lib/cmLang.js";
import { detectIndentUnit } from "../../../lib/indentDetect.js";
import { fvSyntaxHighlight } from "../../../lib/cmHighlight.js";

const setFindDeco = StateEffect.define();
const findDecoField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setFindDeco)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const findMark = Decoration.mark({ class: "fv-match" });
const findMarkCurrent = Decoration.mark({ class: "fv-match current" });

export function EditView({ editContent, setEditContent, findQuery, currentMatch, matches, filePath }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const docRef = useRef(editContent);
  const contentRef = useRef(editContent);
  contentRef.current = editContent;
  const setEditContentRef = useRef(setEditContent);
  setEditContentRef.current = setEditContent;
  const hadFindRef = useRef(false);

  useEffect(() => {
    const doc = contentRef.current;
    const unit = detectIndentUnit(doc, filePath);
    const lang = cmLanguageFor(filePath);
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          indentOnInput(),
          indentUnit.of(unit),
          EditorState.tabSize.of(unit === "\t" ? 4 : unit.length),
          fvSyntaxHighlight,
          findDecoField,
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          ...(lang ? [lang] : []),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            docRef.current = text;
            setEditContentRef.current(text);
          }),
        ],
      }),
      parent: hostRef.current,
    });
    docRef.current = doc;
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [filePath]);

  // External resets (e.g. Cancel) — doc edits flow through updateListener, so
  // docRef only diverges from editContent when the change came from outside.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || docRef.current === editContent) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: editContent } });
  }, [editContent]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const qLen = findQuery.length;
    if (!qLen && !hadFindRef.current) return;
    hadFindRef.current = qLen > 0;
    const docLen = view.state.doc.length;
    const ranges = [];
    for (let i = 0; i < matches.length; i++) {
      const from = matches[i];
      if (from + qLen > docLen) continue;
      ranges.push((i === currentMatch ? findMarkCurrent : findMark).range(from, from + qLen));
    }
    const effects = [setFindDeco.of(Decoration.set(ranges))];
    const cur = matches[currentMatch];
    if (cur != null && cur + qLen <= docLen) {
      effects.push(EditorView.scrollIntoView(cur, { y: "center" }));
    }
    view.dispatch({ effects });
  }, [findQuery, currentMatch, matches]);

  return <div className="fv-editor" ref={hostRef} />;
}
