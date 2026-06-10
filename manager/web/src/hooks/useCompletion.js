import { useEffect, useRef, useState, useMemo } from "react";
import { api } from "../api/client.js";
import { triggerContext } from "../lib/triggerContext.js";

export function useCompletion({ text, cursorPos, commands, cwd, selected, workers, insertedPathsRef }) {
  const [fileResults, setFileResults] = useState([]);

  const slashCtx = useMemo(() => triggerContext(text, cursorPos, "/"), [text, cursorPos]);

  const atCtx = useMemo(() => triggerContext(text, cursorPos, "@"), [text, cursorPos]);

  const filtered = useMemo(() => {
    if (!slashCtx) return [];
    if (slashCtx.query === "") return commands;
    return commands.filter((c) =>
      c.name.toLowerCase().includes(slashCtx.query)
    );
  }, [commands, slashCtx]);

  const rootCacheRef = useRef({ cwd: null, entries: [] });
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    api.listFiles(cwd, "").then((r) => {
      if (!cancelled) rootCacheRef.current = { cwd, entries: r.entries ?? [] };
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [cwd]);

  const fileQuery = atCtx ? atCtx.query : null;
  useEffect(() => {
    if (fileQuery === null || !cwd) { setFileResults([]); return; }
    if (fileQuery === "" && rootCacheRef.current.cwd === cwd) {
      setFileResults(rootCacheRef.current.entries);
      return;
    }
    let cancelled = false;
    const delay = fileQuery === "" ? 0 : 150;
    const timer = setTimeout(() => {
      api.listFiles(cwd, fileQuery).then((r) => {
        if (!cancelled) setFileResults(r.entries ?? []);
      }).catch(() => {});
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fileQuery, cwd]);

  const childAgents = useMemo(() => {
    if (!selected || selected.parent_id) return [];
    return workers
      .filter((w) => w.parent_id === selected.id)
      .map((w) => ({ name: w.name || w.id, type: "agent", state: w.state, id: w.id }));
  }, [selected, workers]);

  const atResults = useMemo(() => {
    if (!atCtx) return [];
    const q = atCtx.query;
    const agents = q === ""
      ? childAgents
      : childAgents.filter((a) => a.name.toLowerCase().includes(q));
    return [...agents, ...fileResults];
  }, [atCtx, childAgents, fileResults]);

  const activeMenu = useMemo(() => {
    if (slashCtx && atCtx) {
      return atCtx.start < slashCtx.start ? "file" : "slash";
    }
    if (slashCtx && filtered.length > 0) return "slash";
    if (atCtx && atResults.length > 0) return "file";
    return null;
  }, [slashCtx, atCtx, filtered.length, atResults.length]);

  useEffect(() => {
    const paths = insertedPathsRef.current;
    for (const [display] of paths) {
      const token = "@" + display;
      const idx = text.indexOf(token);
      if (idx === -1) { paths.delete(display); continue; }
      const after = text[idx + token.length];
      if (after && after !== " " && after !== "\n") paths.delete(display);
    }
  }, [text, insertedPathsRef]);

  return {
    slashCtx,
    atCtx,
    filtered,
    atResults,
    activeMenu,
  };
}
