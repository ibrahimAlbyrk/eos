import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { livePreview, livePreviewTheme } from "./editor/livePreview.js";
import { pageCompletions } from "./editor/completions.js";
import { selectionBar } from "./editor/selectionBar.js";
import { startCompletion } from "@codemirror/autocomplete";
import { pageActions } from "./editor/pageActions.js";
import { PREFIXES, insertCodeBlock, setLineBlock, toggleTaskCommand } from "./editor/blocks.js";

// The page body editor: CodeMirror over plain markdown with a live preview.
// The parent owns saving; it hears every user edit through onChange and pushes
// a newer remote version in with setDoc (applied as a minimal change so the
// caret keeps its place, and kept out of undo history).

const remote = Annotation.define();

export const PageEditor = forwardRef(function PageEditor({ initialDoc, onChange, actionsRef }, ref) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          history(),
          markdown({ base: markdownLanguage }),
          keymap.of([
            { key: "Mod-Enter", run: toggleTaskCommand },
            ...markdownKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          placeholder("Type / for blocks, @ to mention a file"),
          pageActions.of(actionsRef),
          livePreview,
          livePreviewTheme,
          pageCompletions,
          selectionBar,
          EditorView.contentAttributes.of({ "aria-label": "Page content", spellcheck: "true" }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.every((t) => t.annotation(remote))) return;
            onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => view.destroy();
    // The editor mounts once per page; later docs arrive through setDoc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    setDoc(text) {
      const view = viewRef.current;
      if (!view) return;
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let start = 0;
      while (start < cur.length && start < text.length && cur[start] === text[start]) start += 1;
      let end = 0;
      while (end < cur.length - start && end < text.length - start && cur[cur.length - 1 - end] === text[text.length - 1 - end]) end += 1;
      view.dispatch({
        changes: { from: start, to: cur.length - end, insert: text.slice(start, text.length - end) },
        annotations: [remote.of(true), Transaction.addToHistory.of(false)],
      });
    },
    // From the title: the caret goes to the top of the body.
    focusStart() {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
      view.focus();
    },
    block(kind) {
      const view = viewRef.current;
      if (!view) return;
      if (kind === "code") insertCodeBlock(view);
      else setLineBlock(view, PREFIXES[kind]);
    },
    mention() {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const before = from > 0 ? view.state.sliceDoc(from - 1, from) : "";
      const insert = before && !/\s/.test(before) ? " @" : "@";
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input" });
      view.focus();
      startCompletion(view);
    },
  }), []);

  return <div className="pg-editor" ref={hostRef} />;
});
