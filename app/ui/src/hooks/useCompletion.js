import { useEffect, useRef, useState, useMemo } from "react";
import { api } from "../api/client.js";
import { triggerContext } from "../lib/triggerContext.js";
import { resolveMentionQuery } from "../lib/mentionQuery.js";
import { nameOf } from "../lib/agentName.js";

export function useCompletion({ text, cursorPos, commands, cwd, selected, workers, insertedPathsRef }) {
  const slashCtx = useMemo(() => triggerContext(text, cursorPos, "/"), [text, cursorPos]);

  const atCtx = useMemo(() => triggerContext(text, cursorPos, "@"), [text, cursorPos]);

  const filtered = useMemo(() => {
    if (!slashCtx) return [];
    if (slashCtx.query === "") return commands;
    return commands.filter((c) =>
      c.name.toLowerCase().includes(slashCtx.query)
    );
  }, [commands, slashCtx]);

  // Navigation intent from the real-case fragment after `@` (triggerContext
  // lowercases its query, but paths must keep their case for the filesystem).
  const atIntent = useMemo(() => {
    if (!atCtx) return null;
    return resolveMentionQuery(text.slice(atCtx.start + 1, cursorPos));
  }, [atCtx, text, cursorPos]);

  // Browse mode: one listing per directory, cached by (cwd, dir) and filtered
  // in memory — so typing within a directory never refetches, and stepping
  // back to a visited directory is instant.
  const dirCacheRef = useRef(new Map());
  const [browseEntries, setBrowseEntries] = useState([]);
  const [loadedDir, setLoadedDir] = useState(null); // { cwd, dir } now in browseEntries
  const wantDir = atIntent?.mode === "browse" ? atIntent.dir : null;
  useEffect(() => {
    if (wantDir === null || !cwd) return;
    const key = cwd + "\0" + wantDir;
    const cached = dirCacheRef.current.get(key);
    if (cached) { setBrowseEntries(cached); setLoadedDir({ cwd, dir: wantDir }); return; }
    let cancelled = false;
    api.listFiles(cwd, "", { dir: wantDir }).then((r) => {
      if (cancelled) return;
      const entries = r.entries ?? [];
      dirCacheRef.current.set(key, entries);
      setBrowseEntries(entries);
      setLoadedDir({ cwd, dir: wantDir });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [wantDir, cwd]);

  // Pre-warm the root listing so the bare `@` menu opens with no flash.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    api.listFiles(cwd, "").then((r) => {
      if (!cancelled) dirCacheRef.current.set(cwd + "\0", r.entries ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [cwd]);

  // Search mode: repo-wide fuzzy match, debounced.
  const [searchEntries, setSearchEntries] = useState([]);
  const searchTerm = atIntent?.mode === "search" ? atIntent.filter : null;
  useEffect(() => {
    if (searchTerm === null || !cwd) { setSearchEntries([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.listFiles(cwd, searchTerm).then((r) => {
        if (!cancelled) setSearchEntries(r.entries ?? []);
      }).catch(() => {});
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchTerm, cwd]);

  const fileResults = useMemo(() => {
    if (!atIntent) return [];
    if (atIntent.mode === "search") return searchEntries;
    if (!loadedDir || loadedDir.cwd !== cwd || loadedDir.dir !== atIntent.dir) return [];
    const f = atIntent.filter.toLowerCase();
    return f ? browseEntries.filter((e) => e.name.toLowerCase().includes(f)) : browseEntries;
  }, [atIntent, searchEntries, browseEntries, loadedDir, cwd]);

  const childAgents = useMemo(() => {
    if (!selected || selected.parent_id) return [];
    return workers
      .filter((w) => w.parent_id === selected.id)
      .map((w) => ({ name: nameOf(w), type: "agent", state: w.state, id: w.id }));
  }, [selected, workers]);

  const atResults = useMemo(() => {
    if (!atIntent) return [];
    // Agents live at the top level only — hide them while browsing a subdir.
    const agents = atIntent.dir
      ? []
      : atIntent.filter
        ? childAgents.filter((a) => a.name.toLowerCase().includes(atIntent.filter.toLowerCase()))
        : childAgents;
    // `..` row to step back up while inside a directory.
    const up = atIntent.mode === "browse" && atIntent.dir ? [{ type: "parent", name: ".." }] : [];
    return [...up, ...agents, ...fileResults];
  }, [atIntent, childAgents, fileResults]);

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
    atIntent,
    filtered,
    atResults,
    activeMenu,
  };
}
