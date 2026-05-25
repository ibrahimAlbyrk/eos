import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { useCommands } from "../../hooks/useCommands.js";
import { ComposerConfigRow } from "./ComposerConfigRow.jsx";
import { ComposerDiffRow } from "./ComposerDiffRow.jsx";
import { ComposerControls } from "./ComposerControls.jsx";
import { CommandMenu } from "./CommandMenu.jsx";
import { AttachmentChips } from "./AttachmentChips.jsx";

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

function colorize(text, cmdMap) {
  if (!text.includes("/") || !cmdMap.size) return null;
  let html = "";
  let last = 0;
  let found = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "/") continue;
    let end = i + 1;
    while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
    const name = text.slice(i + 1, end);
    const cmd = cmdMap.get(name);
    if (!cmd) continue;
    found = true;
    if (i > last) html += esc(text.slice(last, i));
    html += `<span class="cmd-hl">${esc(text.slice(i, end))}</span>`;
    last = end;
    i = end - 1;
  }
  if (!found) return null;
  if (last < text.length) html += esc(text.slice(last));
  return html;
}

export function Composer({ live }) {
  const ui = useUi();
  const [text, setText] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const editorRef = useRef(null);
  const lastHtmlRef = useRef("");
  const suppressInputRef = useRef(false);

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

  const filtered = useMemo(() => {
    if (!slashCtx) return [];
    if (slashCtx.query === "") return commands;
    return commands.filter((c) =>
      c.name.toLowerCase().includes(slashCtx.query)
    );
  }, [commands, slashCtx]);

  const showMenu = filtered.length > 0;

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

  const applyColoring = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const html = colorize(text, cmdMap);
    const target = html ?? esc(text);
    if (target !== lastHtmlRef.current) {
      const off = getCursorOffset(el);
      suppressInputRef.current = true;
      lastHtmlRef.current = target;
      el.innerHTML = target;
      setCursorOffset(el, off);
    }
  }, [text, cmdMap]);

  useLayoutEffect(() => { applyColoring(); }, [applyColoring]);

  const setTextAndSync = useCallback((newText, newCursor) => {
    suppressInputRef.current = true;
    setText(newText);
    setCursorPos(newCursor ?? newText.length);
    const el = editorRef.current;
    if (!el) return;
    const html = colorize(newText, cmdMap);
    lastHtmlRef.current = html ?? esc(newText);
    el.innerHTML = lastHtmlRef.current;
    setCursorOffset(el, newCursor ?? newText.length);
  }, [cmdMap]);

  const handleInput = () => {
    if (suppressInputRef.current) { suppressInputRef.current = false; return; }
    const el = editorRef.current;
    if (!el) return;
    const raw = el.innerText;
    const off = getCursorOffset(el);
    setText(raw);
    setCursorPos(off);
  };

  const handlePaste = (e) => {
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

  const send = async () => {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    setTextAndSync("", 0);
    const currentAttachments = [...attachments];
    setAttachments([]);

    let fullText = t;
    if (currentAttachments.length > 0) {
      const lines = currentAttachments.map((a) => `- ${a.type}: ${a.path}`).join("\n");
      fullText = t ? `${t}\n\nattachments:\n${lines}` : `attachments:\n${lines}`;
    }

    if (isDraft) {
      const cwd = draft.cwd ?? live.recents[0] ?? null;
      if (!cwd) { alert("Pick a folder first."); return; }
      const draftId = ui.selectedId;
      const r = await live.spawnOrchestrator({
        name: draft.name || undefined,
        cwd,
        model: draft.model,
      });
      if (r?.ok && r.body?.id) {
        const realId = r.body.id;
        ui.removeDraft(draftId);
        ui.setSelectedId(realId);
        ui.addOptimisticUserMessage(realId, fullText);
        setTimeout(() => { api.sendOrchestratorMessage(realId, fullText); }, 1500);
      } else {
        console.error("spawn failed:", r);
        alert("Failed to create orchestrator.");
      }
      return;
    }

    if (selected) {
      ui.addOptimisticUserMessage(selected.id, fullText);
      try { await live.sendToAgent(selected.id, fullText); }
      catch (e) { console.error("send failed:", e); }
      return;
    }

    const cwdFallback = ui.composer.cwd ?? live.recents[0] ?? null;
    if (!cwdFallback) { alert("Pick a folder first."); return; }
    const r = await live.spawnOrchestrator({ cwd: cwdFallback, model: ui.composer.model });
    if (r?.ok && r.body?.id) {
      const realId = r.body.id;
      ui.setSelectedId(realId);
      ui.addOptimisticUserMessage(realId, fullText);
      setTimeout(() => { api.sendOrchestratorMessage(realId, fullText); }, 1500);
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
        setTextAndSync("", 0);
        return;
      }
    }

    if (e.key === "Backspace") {
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : 0;
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

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {selected ? (
          <ComposerDiffRow live={live} />
        ) : (
          <ComposerConfigRow live={live} />
        )}

        <div className="c-row2-wrap">
          <CommandMenu
            commands={filtered}
            selectedIndex={menuIndex}
            onSelect={selectCommand}
            query={slashCtx?.query ?? ""}
          />
          <div className="c-row2">
            {attachments.length > 0 && (
              <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
            )}
            <div
              ref={editorRef}
              className="composer-editor"
              contentEditable
              role="textbox"
              data-placeholder="Type / for commands"
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
