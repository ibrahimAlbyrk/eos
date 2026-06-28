import { useCallback, useRef, useState } from "react";
import { api } from "../api/client.js";
import { makeLabel, buildAttachmentSuffix, reconcileAttachmentItems } from "../lib/attachmentTokens.js";

function baseName(p) {
  const t = p.endsWith("/") ? p.slice(0, -1) : p;
  return t.split("/").pop() || t;
}

// Inline composer attachments: each item is rendered as a [name…] token in
// the editor and a preview chip. `pathsRef` outlives clear() so a send that is
// still awaiting uploads can resolve labels after the UI was reset.
export function useAttachments({ onUploadFailed } = {}) {
  const [items, setItems] = useState([]);
  const usedLabelsRef = useRef(new Set());
  const pathsRef = useRef(new Map());
  const kindsRef = useRef(new Map());
  const pendingRef = useRef(new Map());
  const onUploadFailedRef = useRef(onUploadFailed);
  onUploadFailedRef.current = onUploadFailed;

  const nextLabel = useCallback((name, kind) => {
    for (let n = 1; ; n++) {
      const label = makeLabel(name, n);
      if (usedLabelsRef.current.has(label)) continue;
      usedLabelsRef.current.add(label);
      kindsRef.current.set(label, kind);
      return label;
    }
  }, []);

  const addPath = useCallback((kind, path) => {
    const label = nextLabel(baseName(path), kind);
    pathsRef.current.set(label, path);
    setItems((prev) => [...prev, { label, kind, path, status: "ready" }]);
    return label;
  }, [nextLabel]);

  // Re-seat an attachment whose label, kind and resolved path are already known
  // (reconstructed from a pasted "attachments:" suffix) — no upload, no new
  // label, so the inline [label] token the pasted text already carries stays
  // backed. If the label is live for a DIFFERENT path, mint a fresh one and
  // return { from, to } so the caller rewrites the token; else returns null.
  const addResolved = useCallback(({ label, kind, path }) => {
    const taken = usedLabelsRef.current.has(label) && pathsRef.current.get(label) !== path;
    const finalLabel = taken ? nextLabel(baseName(path), kind) : label;
    usedLabelsRef.current.add(finalLabel);
    kindsRef.current.set(finalLabel, kind);
    pathsRef.current.set(finalLabel, path);
    setItems((prev) => prev.some((it) => it.label === finalLabel)
      ? prev
      : [...prev, { label: finalLabel, kind, path, status: "ready" }]);
    return taken ? { from: label, to: finalLabel } : null;
  }, [nextLabel]);

  // `src` is a File or a paste-event snapshot {name, bytes} — the bytes were
  // captured synchronously inside the paste event, so the upload threads them
  // through to the api without re-reading a (possibly emptied) File.
  const addUpload = useCallback((kind, src) => {
    const label = nextLabel(src.name || kind, kind);
    setItems((prev) => [...prev, { label, kind, path: null, status: "uploading" }]);
    const job = api.uploadPaste(src)
      .then((res) => {
        if (!res.ok || !res.body?.path) throw new Error(`upload failed (${res.status})`);
        pathsRef.current.set(label, res.body.path);
        setItems((prev) => prev.map((it) =>
          it.label === label ? { ...it, path: res.body.path, status: "ready" } : it
        ));
      })
      .catch((err) => {
        console.error("paste upload failed:", err);
        setItems((prev) => prev.filter((it) => it.label !== label));
        onUploadFailedRef.current?.(label);
      })
      .finally(() => pendingRef.current.delete(label));
    pendingRef.current.set(label, job);
    return label;
  }, [nextLabel]);

  const remove = useCallback((label) => {
    setItems((prev) => prev.filter((it) => it.label !== label));
  }, []);

  // usedLabels survives clear(): labels key the global pathsRef and other
  // agents' stashed drafts may still hold older labels — resetting would mint
  // duplicate labels that overwrite their paths.
  const clear = useCallback(() => {
    setItems([]);
  }, []);

  // Re-seat a stashed draft's items after an agent switch. An upload that
  // settled while stashed left no trace in `items` (its setItems mapped over
  // another agent's list) — reconcile from pathsRef/pendingRef: finished →
  // ready, still in flight → keep, failed → drop.
  const restore = useCallback((list) => {
    for (const it of list) usedLabelsRef.current.add(it.label);
    setItems(list.flatMap((it) => {
      if (it.status !== "uploading") return [it];
      const path = pathsRef.current.get(it.label);
      if (path) return [{ ...it, path, status: "ready" }];
      if (pendingRef.current.has(it.label)) return [it];
      return [];
    }));
  }, []);

  // Undo/redo restored `text`: re-seat a chip for every known label the text
  // contains but `items` lacks (paths/kinds survive remove/clear, so a removed
  // chip can come back), and drop chips whose label the text no longer holds.
  // Upload state is reconciled like restore(): resolved → ready, in flight →
  // kept, gone → skipped. Called only on undo/redo, so normal typing that
  // happens to match an old label never resurrects a chip.
  const reconcileToText = useCallback((text) => {
    setItems((prev) => reconcileAttachmentItems(prev, text, {
      usedLabels: usedLabelsRef.current,
      paths: pathsRef.current,
      kinds: kindsRef.current,
      pending: pendingRef.current,
    }));
  }, []);

  // Returns the "attachments:" mapping suffix for the given labels — kept as
  // a suffix (not inline substitution) so the UI can keep showing tokens while
  // claude still sees the absolute paths and auto-attaches them.
  const resolveForSend = useCallback(async (labels) => {
    await Promise.allSettled([...pendingRef.current.values()]);
    return buildAttachmentSuffix(labels, pathsRef.current, kindsRef.current);
  }, []);

  // Like resolveForSend but returns structured {label, kind, path} items instead
  // of the suffix string — for the template editor, which persists attachments as
  // a field. Awaits in-flight uploads then reads resolved paths/kinds from the
  // refs (so a path that settled after the last render is still seen), dropping
  // any that never resolved.
  const resolveItemsForSend = useCallback(async (labels) => {
    await Promise.allSettled([...pendingRef.current.values()]);
    return labels
      .map((label) => ({ label, kind: kindsRef.current.get(label), path: pathsRef.current.get(label) }))
      .filter((it) => it.path && it.kind);
  }, []);

  return { items, addPath, addResolved, addUpload, remove, clear, restore, reconcileToText, resolveForSend, resolveItemsForSend };
}
