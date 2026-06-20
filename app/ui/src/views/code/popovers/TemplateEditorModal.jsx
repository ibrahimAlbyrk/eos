import { useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { refreshTemplates } from "../../../hooks/useTemplates.js";
import { useAttachments } from "../../../hooks/useAttachments.js";
import { useAttachmentIntake } from "../../../hooks/useAttachmentIntake.js";
import {
  useContentEditableEditor,
  getCursorOffset,
  getSelectionOffsets,
  setSelectionOffsets,
  scrollSelectionIntoView,
} from "../../../hooks/useContentEditableEditor.js";
import { findPlaceholders, nextPlaceholder, prevPlaceholder } from "../../../lib/placeholders.js";
import { listIndent } from "../../../lib/markdownBlocks.js";
import { attachmentKind } from "../../../lib/attachmentKind.js";
import { AttachmentChips } from "../center/AttachmentChips.jsx";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Create/edit dialog for prompt templates. `initial` null = create mode;
// rename on edit = create new file + delete old (daemon has no rename).
// The Content field is the same contentEditable + attachment intake the message
// composer uses, so pasting/dropping/picking images attaches them as [label]
// chips; they ride into the input as reference files when the template is used.
export function TemplateEditorModal({ initial, onClose }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const nameInputRef = useRef(null);

  // Content surface — mirrors the composer's editor wiring (no slash commands /
  // @-mentions here, so those refs stay empty).
  const uploadFailedRef = useRef(() => {});
  const insertedPathsRef = useRef(new Map());
  const cmdMapRef = useRef(new Map());
  const attachments = useAttachments({ onUploadFailed: (label) => uploadFailedRef.current(label) });
  const { items: attachmentItems, addResolved, reconcileToText, resolveItemsForSend } = attachments;
  const editor = useContentEditableEditor(cmdMapRef.current, insertedPathsRef, "template-editor", attachmentItems, reconcileToText);
  const { text, setTextAndSync, cursorPos, setCursorPos, editorRef, handleInput } = editor;
  const intake = useAttachmentIntake({ attachments, editor: { text, setTextAndSync, cursorPos, editorRef } });
  const { handlePaste, addAttachments, removeAttachmentToken, attachmentBackspace, dropActive } = intake;
  uploadFailedRef.current = intake.stripLabel;

  // Load the existing template once: re-seat its attachment chips (paths are
  // already durable — no upload), then its content. Create mode focuses Name.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    if (initial) {
      for (const att of initial.attachments ?? []) addResolved(att);
      setTextAndSync(initial.content ?? "", (initial.content ?? "").length, "reset");
      editorRef.current?.focus();
    } else {
      nameInputRef.current?.focus();
    }
  }, []);

  // Capture phase so Escape doesn't fall through to the app-wide chain
  // (popover close / agent interrupt) while the modal is open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // An image lightbox (portal over the modal) owns Escape first: let its own
      // bubbling handler close it, but preventDefault so the global Escape chain
      // (rewind/interrupt) stays inert and the modal itself doesn't close.
      if (document.querySelector(".lightbox-overlay")) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const selectPlaceholder = (el, ph) => {
    setSelectionOffsets(el, ph.start, ph.end);
    scrollSelectionIntoView(el);
    setCursorPos(ph.start);
  };

  const onEditorKey = (e) => {
    if (e.key === "Tab") {
      const phs = findPlaceholders(text);
      if (phs.length > 0) {
        e.preventDefault();
        const el = editorRef.current;
        if (!el) return;
        const sel = getSelectionOffsets(el);
        const ph = e.shiftKey ? prevPlaceholder(phs, sel.start) : nextPlaceholder(phs, sel.end);
        if (ph) selectPlaceholder(el, ph);
        return;
      }
      // No placeholders → Tab indents / Shift+Tab outdents a markdown list line;
      // otherwise swallow Tab so it doesn't move focus out of the editor.
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : cursorPos;
      const indented = listIndent(text, pos, e.shiftKey);
      e.preventDefault();
      if (indented) setTextAndSync(indented.text, indented.cursorPos);
      return;
    }
    if (e.key === "Backspace") {
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : 0;
      if (attachmentBackspace(pos)) { e.preventDefault(); return; }
    }
  };

  const onPaste = (e) => {
    if (handlePaste(e)) return; // attachment-suffix or file paste handled
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  };

  const pickFiles = async () => {
    try {
      const res = await api.pickFiles();
      if (res?.paths?.length) addAttachments(res.paths.map((p) => ({ type: attachmentKind(p), path: p })));
    } catch {
      /* picker cancelled or unavailable */
    }
  };

  const save = async () => {
    const slug = name.trim();
    if (!NAME_RE.test(slug)) {
      setError("Name: lowercase letters, digits and dashes (e.g. bug-fix)");
      return;
    }
    const content = text.trim();
    if (!content) {
      setError("Content is required");
      return;
    }
    setBusy(true);
    setError(null);
    // Wait for in-flight uploads, then collect resolved attachments. The daemon
    // copies these into the template's durable asset store on save.
    const atts = await resolveItemsForSend(attachmentItems.map((it) => it.label));
    const body = { name: slug, description: description.trim(), content, attachments: atts };
    let r;
    // fetch rejects (vs resolving non-ok) when the daemon is down/restarting —
    // without this catch the modal sticks on "Saving…" and Esc loses the content.
    try {
      if (initial && initial.name === slug) {
        r = await api.updateTemplate(slug, body);
      } else {
        r = await api.createTemplate(body);
        if (r.ok && initial) await api.deleteTemplate(initial.name);
      }
    } catch {
      setBusy(false);
      setError("Daemon unreachable — nothing saved, your content is still here. Try again.");
      return;
    }
    setBusy(false);
    if (!r.ok) {
      setError(r.body?.error ?? `Save failed (${r.status})`);
      return;
    }
    await refreshTemplates();
    onClose();
  };

  return (
    <div className="spawn-overlay open" onMouseDown={onClose}>
      <div className="spawn-modal glass-pop" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="spawn-modal__head">
          <div className="spawn-modal__title">{initial ? "Edit template" : "New template"}</div>
          <button className="spawn-modal__close" title="Close (Esc)" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="spawn-modal__body">
          <div className="spawn-field">
            <label className="spawn-field-label">Name</label>
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="bug-fix"
              spellCheck={false}
            />
          </div>
          <div className="spawn-field">
            <label className="spawn-field-label">Description <span className="optional">optional</span></label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="reproduce & fix a bug"
              spellCheck={false}
            />
          </div>
          <div className="spawn-field">
            <label className="spawn-field-label">Content</label>
            <div className={dropActive ? "tpl-content-wrap drop-active" : "tpl-content-wrap"}>
              {attachmentItems.length > 0 && (
                <AttachmentChips attachments={attachmentItems} onRemove={removeAttachmentToken} />
              )}
              <div
                ref={editorRef}
                className="composer-editor tpl-content-editor"
                contentEditable
                role="textbox"
                data-placeholder={"Fix the bug in {{file}} — paste or drop images to attach"}
                data-empty={!text ? "" : undefined}
                onInput={handleInput}
                onKeyDown={onEditorKey}
                onPaste={onPaste}
                onKeyUp={() => { const el = editorRef.current; if (el) setCursorPos(getCursorOffset(el)); }}
                onClick={() => { const el = editorRef.current; if (el) setCursorPos(getCursorOffset(el)); }}
              />
              <button type="button" className="tpl-attach-btn" title="Add file or photo" onClick={pickFiles}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5.5 6.2 10.3a1.6 1.6 0 0 0 2.3 2.3l4.8-4.8a3 3 0 0 0-4.2-4.2L4 8.5a4.4 4.4 0 0 0 6.2 6.2" />
                </svg>
              </button>
            </div>
            <div className="hint">{"{{label}}"} becomes a tab-stop placeholder · paste or drop images to attach</div>
          </div>
          {error && <div className="tpl-editor-error">{error}</div>}
        </div>
        <div className="spawn-modal__foot">
          <button className="spawn-btn" onClick={onClose}>Cancel</button>
          <button className="perm-btn perm-allow" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
