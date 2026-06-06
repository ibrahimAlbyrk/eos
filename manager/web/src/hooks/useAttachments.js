import { useCallback, useRef, useState } from "react";
import { api } from "../api/client.js";
import { makeLabel, buildAttachmentSuffix } from "../lib/attachmentTokens.js";

// Inline composer attachments: each item is rendered as a {kind #N} token in
// the editor and a preview chip. `pathsRef` outlives clear() so a send that is
// still awaiting uploads can resolve labels after the UI was reset.
export function useAttachments({ onUploadFailed } = {}) {
  const [items, setItems] = useState([]);
  const countersRef = useRef({});
  const pathsRef = useRef(new Map());
  const pendingRef = useRef(new Map());
  const onUploadFailedRef = useRef(onUploadFailed);
  onUploadFailedRef.current = onUploadFailed;

  const nextLabel = useCallback((kind) => {
    const n = (countersRef.current[kind] ?? 0) + 1;
    countersRef.current[kind] = n;
    return makeLabel(kind, n);
  }, []);

  const addPath = useCallback((kind, path) => {
    const label = nextLabel(kind);
    pathsRef.current.set(label, path);
    setItems((prev) => [...prev, { label, kind, path, status: "ready" }]);
    return label;
  }, [nextLabel]);

  const addUpload = useCallback((kind, file) => {
    const label = nextLabel(kind);
    setItems((prev) => [...prev, { label, kind, path: null, status: "uploading" }]);
    const job = api.uploadPaste(file)
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

  const clear = useCallback(() => {
    setItems([]);
    countersRef.current = {};
  }, []);

  // Returns the "attachments:" mapping suffix for the given labels — kept as
  // a suffix (not inline substitution) so the UI can keep showing tokens while
  // claude still sees the absolute paths and auto-attaches them.
  const resolveForSend = useCallback(async (labels) => {
    await Promise.allSettled([...pendingRef.current.values()]);
    return buildAttachmentSuffix(labels, pathsRef.current);
  }, []);

  return { items, addPath, addUpload, remove, clear, resolveForSend };
}
