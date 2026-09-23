import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration,
} from "@codemirror/view";
import { indentOnInput, indentUnit, bracketMatching } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { cmLanguageFor } from "../../../lib/cmLang.js";
import { detectIndentUnit } from "../../../lib/indentDetect.js";
import { fvSyntaxHighlight } from "../../../lib/cmHighlight.js";
import { setCodeLensDeco, codeLensField, buildCodeLensDeco, visibleDefNames } from "../../../lib/cmCodeLens.js";

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

// The bare identifier under a mouse event, via CM's word boundaries — the MVP
// go-to-def token (qualified names defer to the semantic tier).
function wordAtEvent(view, e) {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos == null) return null;
  const range = view.state.wordAt(pos);
  if (!range) return null;
  return view.state.sliceDoc(range.from, range.to);
}

export function EditView({ editContent, setEditContent, findQuery, currentMatch, matches, filePath, readOnly = false, symbolNav = null, revealLine, revealColumn, revealSeq, codeLens = null, onCodeLensClick = null, onVisibleDefs = null }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const docRef = useRef(editContent);
  const contentRef = useRef(editContent);
  contentRef.current = editContent;
  const setEditContentRef = useRef(setEditContent);
  setEditContentRef.current = setEditContent;
  const hadFindRef = useRef(false);
  // Read symbol-nav callbacks through a ref so the extension closure stays stable
  // (no editor remount when the parent passes a fresh object each render).
  const symbolNavRef = useRef(symbolNav);
  symbolNavRef.current = symbolNav;
  const symbolNavEnabled = Boolean(symbolNav);
  // CodeLens chips + lazy viewport-count reporting, all read through refs so the
  // extension closure and per-widget click stay stable across count updates.
  const codeLensRef = useRef(codeLens);
  codeLensRef.current = codeLens;
  const onCodeLensClickRef = useRef(onCodeLensClick);
  onCodeLensClickRef.current = onCodeLensClick;
  const onVisibleDefsRef = useRef(onVisibleDefs);
  onVisibleDefsRef.current = onVisibleDefs;
  const codeLensEnabled = Boolean(onCodeLensClick);
  const lensClick = (def) => onCodeLensClickRef.current?.(def);

  useEffect(() => {
    const doc = contentRef.current;
    const lang = cmLanguageFor(filePath);
    // Opt-in symbol navigation: Cmd/Ctrl-click reveals a definition; right-click
    // on an identifier opens the go-to-def / find-refs menu. When no symbolNav is
    // wired (e.g. the message viewer) this extension is omitted entirely.
    const symbolNavExt = symbolNavEnabled ? [EditorView.domEventHandlers({
      mousedown(e, view) {
        const nav = symbolNavRef.current;
        if (!nav || e.button !== 0 || !(e.metaKey || e.ctrlKey)) return false;
        const word = wordAtEvent(view, e);
        if (!word) return false;
        e.preventDefault();
        nav.onDefinition?.(word);
        return true;
      },
      contextmenu(e, view) {
        const nav = symbolNavRef.current;
        if (!nav) return false;
        const word = wordAtEvent(view, e);
        if (!word) return false;
        e.preventDefault();
        nav.onContextMenu?.({ word, x: e.clientX, y: e.clientY });
        return true;
      },
    })] : [];
    // CodeLens: the block-widget field plus a debounced viewport reporter that
    // asks the parent to resolve reference counts only for the defs on screen.
    const codeLensExt = codeLensEnabled ? [
      codeLensField,
      ViewPlugin.fromClass(class {
        constructor(view) { this.view = view; this.timer = null; this.schedule(); }
        update(u) { if (u.viewportChanged || u.geometryChanged || u.docChanged) this.schedule(); }
        schedule() {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            const cb = onVisibleDefsRef.current;
            const names = visibleDefNames(this.view, codeLensRef.current);
            if (cb && names.length) cb(names);
          }, 250);
        }
        destroy() { clearTimeout(this.timer); }
      }),
    ] : [];
    // Heavy docs open read-only with the minimal set: viewport rendering and
    // syntax stay, editing affordances (history, autocomplete, brackets) go.
    let extensions;
    if (readOnly) {
      extensions = [
        lineNumbers(),
        EditorState.readOnly.of(true),
        fvSyntaxHighlight,
        findDecoField,
        ...symbolNavExt,
        ...codeLensExt,
        keymap.of(defaultKeymap),
        ...(lang ? [lang] : []),
      ];
    } else {
      const unit = detectIndentUnit(doc, filePath);
      extensions = [
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
        ...symbolNavExt,
        ...codeLensExt,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        ...(lang ? [lang] : []),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const text = u.state.doc.toString();
          docRef.current = text;
          setEditContentRef.current(text);
        }),
      ];
    }
    const view = new EditorView({
      state: EditorState.create({ doc, extensions }),
      parent: hostRef.current,
    });
    docRef.current = doc;
    viewRef.current = view;
    // Seed a freshly-created view with the current chips (a remount — file switch
    // or readOnly flip — otherwise starts with an empty CodeLens field).
    if (codeLensEnabled) {
      view.dispatch({ effects: setCodeLensDeco.of(buildCodeLensDeco(view.state, codeLensRef.current ?? [], lensClick)) });
    }
    return () => { view.destroy(); viewRef.current = null; };
  }, [filePath, readOnly, symbolNavEnabled, codeLensEnabled]);

  // Scroll-to-line for go-to-definition / reference navigation. Keyed off
  // revealSeq so re-navigating to the same line still re-centers.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealLine) return;
    const total = view.state.doc.lines;
    const ln = Math.min(Math.max(revealLine, 1), total);
    const lineObj = view.state.doc.line(ln);
    const col = revealColumn ? Math.min(Math.max(revealColumn - 1, 0), lineObj.length) : 0;
    const pos = lineObj.from + col;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  }, [revealLine, revealColumn, revealSeq]);

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

  // Re-render chips whenever the def list or a resolved count changes, then ask
  // for counts of any defs currently on screen (covers the first load, where
  // defs arrive after mount and the viewport reporter hasn't fired yet).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !codeLensEnabled) return;
    view.dispatch({ effects: setCodeLensDeco.of(buildCodeLensDeco(view.state, codeLens ?? [], lensClick)) });
    const names = visibleDefNames(view, codeLens ?? []);
    if (names.length && onVisibleDefsRef.current) onVisibleDefsRef.current(names);
  }, [codeLens, codeLensEnabled]);

  const isMd = /\.(md|mdx|markdown)$/i.test(filePath ?? "");
  return <div className={"fv-editor" + (isMd ? " fv-editor--md" : "")} ref={hostRef} />;
}
