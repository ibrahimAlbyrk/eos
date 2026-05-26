import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { useCommands } from "../../hooks/useCommands.js";
import { ComposerConfigRow } from "./ComposerConfigRow.jsx";
import { ComposerDiffRow } from "./ComposerDiffRow.jsx";
import { ComposerControls } from "./ComposerControls.jsx";
import { CommandMenu } from "./CommandMenu.jsx";
import { FileMenu } from "./FileMenu.jsx";
import { AttachmentChips } from "./AttachmentChips.jsx";
import { PermissionBanner } from "./PermissionBanner.jsx";

function getCursorOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}

function setCursorOffset(el, offset) {
  const sel = window.getSelection();
  const range = document.createRange();
  let pos = 0;
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent.length;
      if (pos + len >= offset) {
        range.setStart(node, offset - pos);
        range.collapse(true);
        return true;
      }
      pos += len;
      return false;
    }
    for (const child of node.childNodes) {
      if (walk(child)) return true;
    }
    return false;
  }
  if (walk(el)) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function colorize(text, cmdMap, filePaths) {
  const regions = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "/") continue;
    let end = i + 1;
    while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
    if (cmdMap.has(text.slice(i + 1, end))) {
      regions.push({ start: i, end });
    }
  }

  for (const [display] of filePaths) {
    const token = "@" + display;
    let idx = 0;
    while ((idx = text.indexOf(token, idx)) !== -1) {
      regions.push({ start: idx, end: idx + token.length });
      idx += token.length;
    }
  }

  if (regions.length === 0) return null;
  regions.sort((a, b) => a.start - b.start);

  let html = "";
  let last = 0;
  for (const r of regions) {
    if (r.start < last) continue;
    if (r.start > last) html += esc(text.slice(last, r.start));
    html += `<span class="cmd-hl">${esc(text.slice(r.start, r.end))}</span>`;
    last = r.end;
  }
  if (last === 0) return null;
  if (last < text.length) html += esc(text.slice(last));
  return html;
}

function QueuedPill({ text, onDismiss }) {
  return (
    <div className="queued-pill">
      <div className="queued-pill-text">{text}</div>
      <button className="queued-pill-x" onClick={onDismiss} title="Cancel queued message">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

export function Composer({ live }) {
  const ui = useUi();
  const [text, setText] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const [fileResults, setFileResults] = useState([]);
  const editorRef = useRef(null);
  const lastHtmlRef = useRef("");
  const suppressInputRef = useRef(false);
  const insertedPathsRef = useRef(new Map());

  const [attachments, setAttachments] = useState([]);
  const addAttachment = useCallback((att) => {
    setAttachments((prev) => {
      if (prev.some((a) => a.path === att.path)) return prev;
      return [...prev, att];
    });
  }, []);
  const removeAttachment = useCallback((path) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  const draft = ui.drafts.get(ui.selectedId);
  const isDraft = !!draft;
  const selected = !isDraft ? live.workers.find((w) => w.id === ui.selectedId) : null;

  const cwd = isDraft
    ? (draft.cwd ?? live.recents[0] ?? null)
    : (selected?.cwd ?? ui.composer.cwd ?? live.recents[0] ?? null);
  const commands = useCommands(cwd);
  const cmdMap = useMemo(() => new Map(commands.map((c) => [c.name, c])), [commands]);

  const [cursorPos, setCursorPos] = useState(0);

  const slashCtx = useMemo(() => {
    const before = text.slice(0, cursorPos);
    const slashIdx = before.lastIndexOf("/");
    if (slashIdx === -1) return null;
    const fragment = before.slice(slashIdx + 1);
    if (fragment.includes(" ") || fragment.includes("\n")) return null;
    return { start: slashIdx, query: fragment.toLowerCase() };
  }, [text, cursorPos]);

  const atCtx = useMemo(() => {
    const before = text.slice(0, cursorPos);
    const atIdx = before.lastIndexOf("@");
    if (atIdx === -1) return null;
    const fragment = before.slice(atIdx + 1);
    if (fragment.includes(" ") || fragment.includes("\n")) return null;
    return { start: atIdx, query: fragment.toLowerCase() };
  }, [text, cursorPos]);

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
    return live.workers
      .filter((w) => w.parent_id === selected.id)
      .map((w) => ({ name: w.name || w.id, type: "agent", state: w.state, id: w.id }));
  }, [selected, live.workers]);

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

  const showMenu = activeMenu === "slash";
  const showFileMenu = activeMenu === "file";

  const activeHint = useMemo(() => {
    if (!text.includes("/")) return null;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "/") continue;
      let end = i + 1;
      while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
      const cmd = cmdMap.get(text.slice(i + 1, end));
      if (!cmd?.argumentHint) continue;
      const after = text.slice(end);
      if (after === " ") return cmd.argumentHint;
    }
    return null;
  }, [text, cmdMap]);

  useEffect(() => { setMenuIndex(0); }, [slashCtx?.query]);
  useEffect(() => { setFileMenuIndex(0); }, [atCtx?.query]);

  useEffect(() => {
    const paths = insertedPathsRef.current;
    for (const [display] of paths) {
      const token = "@" + display;
      const idx = text.indexOf(token);
      if (idx === -1) { paths.delete(display); continue; }
      const after = text[idx + token.length];
      if (after && after !== " " && after !== "\n") paths.delete(display);
    }
  }, [text]);

  const applyColoring = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const html = colorize(text, cmdMap, insertedPathsRef.current);
    const target = html ?? esc(text);
    if (target !== lastHtmlRef.current) {
      const off = getCursorOffset(el);
      suppressInputRef.current = true;
      lastHtmlRef.current = target;
      el.innerHTML = target;
      setCursorOffset(el, off);
      queueMicrotask(() => { suppressInputRef.current = false; });
    }
  }, [text, cmdMap]);

  useLayoutEffect(() => { applyColoring(); }, [applyColoring]);


  const setTextAndSync = useCallback((newText, newCursor) => {
    suppressInputRef.current = true;
    setText(newText);
    setCursorPos(newCursor ?? newText.length);
    const el = editorRef.current;
    if (!el) return;
    const html = colorize(newText, cmdMap, insertedPathsRef.current);
    lastHtmlRef.current = html ?? esc(newText);
    el.innerHTML = lastHtmlRef.current;
    setCursorOffset(el, newCursor ?? newText.length);
    queueMicrotask(() => { suppressInputRef.current = false; });
  }, [cmdMap]);

  const handleInput = () => {
    if (suppressInputRef.current) { suppressInputRef.current = false; return; }
    const el = editorRef.current;
    if (!el) return;
    let raw = el.innerText;
    if (raw === "\n") raw = "";
    const off = getCursorOffset(el);
    setText(raw);
    setCursorPos(off);
  };

  const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

  const handlePaste = async (e) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      for (const file of files) {
        try {
          const res = await api.uploadPaste(file);
          if (!res.ok || !res.body?.path) continue;
          const ext = res.body.path.split(".").pop()?.toLowerCase() ?? "";
          const type = IMAGE_EXTS.has(ext) || file.type.startsWith("image/") ? "image" : "file";
          addAttachment({ type, path: res.body.path });
        } catch (err) {
          console.error("paste upload failed:", err);
        }
      }
      return;
    }
    e.preventDefault();
    const plain = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, plain);
  };

  const findCommandAt = (pos) => {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "/") continue;
      let end = i + 1;
      while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
      if (cmdMap.has(text.slice(i + 1, end)) && pos > i && pos <= end) {
        return { start: i, end };
      }
    }
    return null;
  };

  const selectCommand = (cmd) => {
    if (slashCtx) {
      const before = text.slice(0, slashCtx.start);
      const after = text.slice(cursorPos);
      const inserted = `/${cmd.name} `;
      const newText = before + inserted + after;
      const newPos = before.length + inserted.length;
      setTextAndSync(newText, newPos);
    } else {
      setTextAndSync(`/${cmd.name} `);
    }
    setMenuIndex(0);
    editorRef.current?.focus();
  };

  const selectFile = (entry) => {
    if (!atCtx) return;
    const before = text.slice(0, atCtx.start);
    const after = text.slice(cursorPos);
    const newDisplay = entry.type === "agent" ? entry.name : entry.relativePath;
    for (const [existing] of insertedPathsRef.current) {
      if (newDisplay.startsWith(existing + "/") || existing.startsWith(newDisplay + "/") || existing === newDisplay) {
        insertedPathsRef.current.delete(existing);
      }
    }
    if (entry.type === "agent") {
      const inserted = "@" + entry.name + " ";
      const newText = before + inserted + after;
      insertedPathsRef.current.set(entry.name, "@" + entry.name);
      setTextAndSync(newText, before.length + inserted.length);
    } else {
      const inserted = "@" + entry.relativePath + " ";
      const newText = before + inserted + after;
      insertedPathsRef.current.set(entry.relativePath, entry.absolutePath);
      setTextAndSync(newText, before.length + inserted.length);
    }
    setFileMenuIndex(0);
    editorRef.current?.focus();
  };

  const findPathAt = (pos) => {
    for (const [display] of insertedPathsRef.current) {
      const token = "@" + display;
      const idx = text.indexOf(token);
      if (idx !== -1 && pos > idx && pos <= idx + token.length) {
        return { start: idx, end: idx + token.length, display };
      }
    }
    return null;
  };

  const send = async () => {
    const t = text.trim();
    if (!t && attachments.length === 0) return;

    let displayText = t;
    let agentText = t;
    for (const [display, absPath] of insertedPathsRef.current) {
      agentText = agentText.replaceAll("@" + display, absPath);
    }

    setTextAndSync("", 0);
    insertedPathsRef.current.clear();
    const currentAttachments = [...attachments];
    setAttachments([]);
    if (currentAttachments.length > 0) {
      const lines = currentAttachments.map((a) => `- ${a.type}: ${a.path}`).join("\n");
      const suffix = `\n\nattachments:\n${lines}`;
      displayText = displayText ? displayText + suffix : `attachments:\n${lines}`;
      agentText = agentText ? agentText + suffix : `attachments:\n${lines}`;
    }

    if (isDraft) {
      const cwd = draft.cwd ?? live.recents[0] ?? null;
      if (!cwd) { alert("Pick a folder first."); return; }
      const draftId = ui.selectedId;
      const r = await live.spawnOrchestrator({
        name: draft.name || undefined,
        cwd,
        model: draft.model,
        effort: draft.effort,
        prompt: agentText,
      });
      if (r?.ok && r.body?.id) {
        const realId = r.body.id;
        ui.removeDraft(draftId);
        ui.setSelectedId(realId);
        ui.addOptimisticUserMessage(realId, displayText, agentText);
      } else {
        console.error("spawn failed:", r);
        alert("Failed to create orchestrator.");
      }
      return;
    }

    if (selected) {
      const busy = selected.state === "SPAWNING" || selected.state === "WORKING";
      if (busy) {
        ui.addQueuedMessage(selected.id, agentText);
        return;
      }
      ui.addOptimisticUserMessage(selected.id, displayText, agentText);
      try { await live.sendToAgent(selected.id, agentText); }
      catch (e) { console.error("send failed:", e); }
      return;
    }

    const cwdFallback = ui.composer.cwd ?? live.recents[0] ?? null;
    if (!cwdFallback) { alert("Pick a folder first."); return; }
    const r = await live.spawnOrchestrator({ cwd: cwdFallback, model: ui.composer.model, effort: ui.composer.effort, prompt: agentText });
    if (r?.ok && r.body?.id) {
      const realId = r.body.id;
      ui.setSelectedId(realId);
      ui.addOptimisticUserMessage(realId, displayText, agentText);
    }
  };

  const onKey = (e) => {
    if (showMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered[menuIndex]) selectCommand(filtered[menuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setTextAndSync("", 0);
        return;
      }
    }

    if (showFileMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileMenuIndex((i) => (i + 1) % atResults.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileMenuIndex((i) => (i - 1 + atResults.length) % atResults.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (atResults[fileMenuIndex]) selectFile(atResults[fileMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setTextAndSync("", 0);
        return;
      }
    }

    if (e.key === "Backspace") {
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : 0;
      const pathHit = findPathAt(pos);
      if (pathHit) {
        e.preventDefault();
        insertedPathsRef.current.delete(pathHit.display);
        const next = text.slice(0, pathHit.start) + text.slice(pathHit.end);
        setTextAndSync(next, pathHit.start);
        return;
      }
      const cmd = findCommandAt(pos);
      if (cmd) {
        e.preventDefault();
        const next = text.slice(0, cmd.start) + text.slice(cmd.end);
        setTextAndSync(next, cmd.start);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const agentBusy = selected && (selected.state === "SPAWNING" || selected.state === "WORKING");
  const queuedList = selected ? (ui.queuedMessages.get(selected.id) ?? []) : [];

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {queuedList.length > 0 && (
          <div className="queued-list">
            {queuedList.map((q) => (
              <QueuedPill
                key={q.id}
                text={q.text}
                onDismiss={() => ui.removeQueuedMessage(selected.id, q.id)}
              />
            ))}
          </div>
        )}
        <PermissionBanner
          permissions={(live.pendingPermissions ?? []).filter(
            (p) => !selected || p.worker_id === selected.id
          )}
          workers={live.workers}
          onApprove={live.approvePending}
          onAlwaysAllow={live.alwaysAllowPending}
          onDeny={live.denyPending}
        />
        {selected ? (
          <ComposerDiffRow live={live} />
        ) : (
          <ComposerConfigRow live={live} />
        )}

        <div className="c-row2-wrap">
          {showMenu && (
            <CommandMenu
              commands={filtered}
              selectedIndex={menuIndex}
              onSelect={selectCommand}
              query={slashCtx?.query ?? ""}
            />
          )}
          {showFileMenu && (
            <FileMenu
              entries={atResults}
              selectedIndex={fileMenuIndex}
              onSelect={selectFile}
              query={atCtx?.query ?? ""}
            />
          )}
          <div className="c-row2">
            {attachments.length > 0 && (
              <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
            )}
            <div
              ref={editorRef}
              className="composer-editor"
              contentEditable
              role="textbox"
              data-placeholder="Type / for commands, @ for files"
              data-empty={!text ? "" : undefined}
              data-hint={activeHint || undefined}
              onInput={handleInput}
              onKeyDown={onKey}
              onPaste={handlePaste}
              onClick={() => { const el = editorRef.current; if (el) setCursorPos(getCursorOffset(el)); }}
              onKeyUp={() => { const el = editorRef.current; if (el) setCursorPos(getCursorOffset(el)); }}
            />
            <button className="submit" title="Send" onClick={send}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v5H4m3-3l-3 3 3 3" />
              </svg>
            </button>
          </div>
        </div>

        <ComposerControls live={live} onAttach={addAttachment} />
      </div>
    </div>
  );
}
