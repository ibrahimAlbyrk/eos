import { useEffect, useRef, useState } from "react";
import { attachmentKind } from "../lib/attachmentKind.js";
import { parseAttachmentMessage, findLabelAt, spliceLabels, labelsDeleted } from "../lib/attachmentTokens.js";
import { getCursorOffset, readEditor } from "./useContentEditableEditor.js";
import { hasPasteboardBridge, readPasteboardPaths, onNativeDrop, onDragState } from "../lib/nativeBridge.js";

// Native Finder drops arrive on a single global bus (nativeBridge). More than one
// composing surface can be mounted at once (the message composer plus an open
// template editor); without arbitration a drop lands in BOTH. This stack tracks
// mount order so a drop / drag-state reaches only the topmost (most recently
// mounted) surface; one shared subscription dispatches to its top.
const dropStack = [];
let dropWired = false;
function ensureDropDispatch() {
  if (dropWired) return;
  dropWired = true;
  onNativeDrop((entries) => dropStack[dropStack.length - 1]?.handleDrop(entries));
  onDragState((active) => dropStack[dropStack.length - 1]?.setDragActive(active));
}

// Shared attachment intake for any contentEditable composing surface: turns
// pasted / dropped / picked files into inline [label] tokens + chips backed by
// uploaded paths. The attachment LIST is the source of truth (it alone feeds the
// send payload); the inline [label] token is its display projection. A chip is
// dropped only by an explicit action — the chip ✕, the token-aware Backspace, or
// a genuine deletion of its token text (select-all+delete, cut). Used by both the
// message composer and the template editor so the two behave identically.
//
// `attachments` is a useAttachments() instance (owned by the caller, which also
// feeds its items into useContentEditableEditor); `editor` exposes the editor
// primitives { text, setTextAndSync, cursorPos, editorRef }.
export function useAttachmentIntake({ attachments, editor }) {
  const { items, addUpload, addPath, addResolved, remove: removeItem } = attachments;
  const { text, setTextAndSync, cursorPos, editorRef } = editor;
  const [dropActive, setDropActive] = useState(false);

  const stripLabel = (label) => {
    const idx = text.indexOf(label);
    if (idx === -1) return;
    let end = idx + label.length;
    if (text[end] === " ") end++;
    setTextAndSync(text.slice(0, idx) + text.slice(end), idx);
  };

  // Insert at the LIVE editor text (read now, not the closed-over render value)
  // so a deferred/native or rapid paste can't compute from a stale snapshot and
  // overwrite a sibling label; clamp the offset off any existing token interior
  // so a new label can never split one. Existing item labels gate both.
  const insertLabels = (labels, pos) => {
    const el = editorRef.current;
    const live = el ? readEditor(el).text : text;
    const existing = items.map((it) => it.label);
    const { text: next, caret } = spliceLabels(live, pos, labels, existing);
    setTextAndSync(next, caret);
  };

  const removeAttachmentToken = (label) => {
    removeItem(label);
    stripLabel(label);
  };

  // The chip list is the source of truth; the token is its projection. Inserts
  // never remove a sibling label (insertLabels splices the live text), so the
  // only thing that drops a chip here is a genuine deletion of its token — a
  // present→absent transition (select-all+delete, cut, a selection spanning it,
  // or the token-aware Backspace). prevText holds the last-seen text to detect it.
  const prevTextRef = useRef(text);
  useEffect(() => {
    const removed = labelsDeleted(prevTextRef.current, text, items.map((it) => it.label));
    prevTextRef.current = text;
    for (const label of removed) removeItem(label);
  }, [text, items, removeItem]);

  const uploadFiles = (files, pos) => {
    // A Finder folder surfaces as a typeless empty File — uploading it fails
    // and flashes the chip, so drop those entries silently.
    const real = files.filter((f) => f.type || f.size);
    if (!real.length) return;
    const labels = real.map((file) => {
      const kind = file.type.startsWith("image/") ? "image" : attachmentKind(file.name);
      return addUpload(kind, file);
    });
    insertLabels(labels, pos);
  };

  // Handles the attachment-suffix and file branches of a paste, returning true
  // when it consumed the event. Plain text is NOT consumed (returns false) so the
  // caller owns its own text-insert policy (verbatim, or the composer's long-paste
  // collapse). The attachment-suffix branch runs BEFORE the file branch so a
  // native ⌘C that also put the image on the clipboard re-seats by path.
  const handlePaste = (e) => {
    const plain = e.clipboardData.getData("text/plain");
    const parsed = parseAttachmentMessage(plain);
    if (parsed.attachments.length) {
      e.preventDefault();
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : text.length;
      let display = parsed.display;
      for (const att of parsed.attachments) {
        if (!att.label || !att.path) continue;
        const remap = addResolved(att);
        if (remap) display = display.replaceAll(remap.from, remap.to);
      }
      setTextAndSync(text.slice(0, pos) + display + text.slice(pos), pos + display.length);
      return true;
    }

    const files = Array.from(e.clipboardData.files);
    const hasFiles = files.length > 0 || e.clipboardData.types.includes("Files");
    if (hasFiles) {
      e.preventDefault();
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : text.length;
      if (hasPasteboardBridge()) {
        // Finder copy → reference the on-disk paths (folders included); raw
        // clipboard data (screenshots) has no path → fall back to upload.
        readPasteboardPaths().then((entries) => {
          if (entries?.length) {
            const labels = entries.map((en) => addPath(attachmentKind(en.path, en.isDir), en.path));
            insertLabels(labels, pos);
          } else {
            uploadFiles(files, pos);
          }
        });
        return true;
      }
      uploadFiles(files, pos);
      return true;
    }
    return false;
  };

  const addAttachments = (atts) => {
    const labels = atts.map((a) => addPath(a.type, a.path));
    insertLabels(labels, cursorPos);
    editorRef.current?.focus();
  };

  // Backspace at the trailing edge of a [label] token deletes the whole token
  // atomically (chip is then GC'd by the source-of-truth effect). Returns true
  // when it consumed the key so the caller can preventDefault.
  const attachmentBackspace = (pos) => {
    const hit = findLabelAt(text, pos, items.map((it) => it.label));
    if (!hit) return false;
    setTextAndSync(text.slice(0, hit.start) + text.slice(hit.end), hit.start);
    return true;
  };

  // Finder drags intercepted by the native layer — paths arrive via the bridge
  // globals; latest closures through a ref, topmost-surface arbitration via the
  // shared stack so an open modal takes drops away from the composer behind it.
  const dropRef = useRef({});
  dropRef.current.handleDrop = (entries) => {
    if (!entries?.length) return;
    addAttachments(entries.map((en) => ({ type: attachmentKind(en.path, en.isDir), path: en.path })));
  };
  dropRef.current.setDragActive = setDropActive;
  useEffect(() => {
    ensureDropDispatch();
    const entry = {
      handleDrop: (es) => dropRef.current.handleDrop(es),
      setDragActive: (a) => dropRef.current.setDragActive(a),
    };
    dropStack.push(entry);
    return () => {
      const i = dropStack.indexOf(entry);
      if (i >= 0) dropStack.splice(i, 1);
      setDropActive(false);
    };
  }, []);

  return {
    handlePaste,
    addAttachments,
    removeAttachmentToken,
    attachmentBackspace,
    stripLabel,
    insertLabels,
    dropActive,
  };
}
