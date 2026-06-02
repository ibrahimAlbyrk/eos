import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useCommands } from "../../../hooks/useCommands.js";
import { useContentEditableEditor, getCursorOffset } from "../../../hooks/useContentEditableEditor.js";
import { useCompletion } from "../../../hooks/useCompletion.js";
import { menuVisibility, escapeMenu, menuDismissedOnQueryChange } from "../../../lib/completionMenu.js";
import { api } from "../../../api/client.js";
import { ComposerConfigRow } from "./ComposerConfigRow.jsx";
import { ComposerDiffRow } from "./ComposerDiffRow.jsx";
import { ComposerControls } from "./ComposerControls.jsx";
import { CommandMenu } from "./CommandMenu.jsx";
import { FileMenu } from "./FileMenu.jsx";
import { AttachmentChips } from "./AttachmentChips.jsx";
import { PermissionBanner } from "./PermissionBanner.jsx";
import { QuestionBanner } from "./QuestionBanner.jsx";

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
  const [menuIndex, setMenuIndex] = useState(0);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
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

  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;

  const cwd = selected?.cwd ?? ui.composer.cwd ?? live.recents[0] ?? null;
  const commands = useCommands(cwd);
  const cmdMap = useMemo(() => new Map(commands.map((c) => [c.name, c])), [commands]);

  const {
    text,
    cursorPos,
    setCursorPos,
    editorRef,
    setTextAndSync,
    handleInput,
  } = useContentEditableEditor(cmdMap, insertedPathsRef, ui.selectedId);

  const { slashCtx, atCtx, filtered, atResults, activeMenu } = useCompletion({
    text,
    cursorPos,
    commands,
    cwd,
    selected,
    workers: live.workers,
    insertedPathsRef,
  });

  const { showMenu, showFileMenu } = menuVisibility({ activeMenu, menuDismissed });

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

  useEffect(() => { setMenuIndex(0); setMenuDismissed(menuDismissedOnQueryChange()); }, [slashCtx?.query]);
  useEffect(() => { setFileMenuIndex(0); setMenuDismissed(menuDismissedOnQueryChange()); }, [atCtx?.query]);

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
    const r = await live.spawnOrchestrator({ cwd: cwdFallback, model: ui.composer.model, effort: ui.composer.effort, prompt: agentText, permissionMode: ui.composer.permissionMode });
    if (r?.ok && r.body?.id) {
      const realId = r.body.id;
      ui.setSelectedId(realId);
      ui.addOptimisticUserMessage(realId, displayText, agentText);
    }
  };

  const applyEscapeMenu = () => {
    const { keepText, dismissed } = escapeMenu();
    if (!keepText) setTextAndSync("", 0);
    setMenuDismissed(dismissed);
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
        applyEscapeMenu();
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
        applyEscapeMenu();
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
        {ui.pendingQuestion && selected && !ui.dismissedQuestions?.has(ui.pendingQuestion.toolUseId) && (
          <QuestionBanner
            questions={ui.pendingQuestion.questions}
            workerId={selected.id}
            toolUseId={ui.pendingQuestion.toolUseId}
            sendToAgent={live.sendToAgent}
            interruptAgent={live.interruptAgent}
            onClose={() => ui.dismissQuestion(ui.pendingQuestion.toolUseId)}
          />
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
