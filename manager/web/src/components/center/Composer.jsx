import { useEffect, useRef, useState, useMemo } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { useCommands } from "../../hooks/useCommands.js";
import { ComposerConfigRow } from "./ComposerConfigRow.jsx";
import { ComposerDiffRow } from "./ComposerDiffRow.jsx";
import { ComposerControls } from "./ComposerControls.jsx";
import { CommandMenu } from "./CommandMenu.jsx";

export function Composer({ live }) {
  const ui = useUi();
  const [text, setText] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const textareaRef = useRef(null);

  const draft = ui.drafts.get(ui.selectedId);
  const isDraft = !!draft;
  const selected = !isDraft ? live.workers.find((w) => w.id === ui.selectedId) : null;

  const cwd = isDraft
    ? (draft.cwd ?? live.recents[0] ?? null)
    : (selected?.cwd ?? ui.composer.cwd ?? live.recents[0] ?? null);
  const commands = useCommands(cwd);

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

  const cmdNames = useMemo(() => new Set(commands.map((c) => c.name)), [commands]);

  const overlayParts = useMemo(() => {
    if (!commands.length || !text.includes("/")) return null;
    const parts = [];
    let last = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "/") continue;
      let end = i + 1;
      while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
      if (!cmdNames.has(text.slice(i + 1, end))) continue;
      if (i > last) parts.push({ text: text.slice(last, i), hl: false });
      parts.push({ text: text.slice(i, end), hl: true });
      last = end;
      i = end - 1;
    }
    if (!parts.length) return null;
    if (last < text.length) parts.push({ text: text.slice(last), hl: false });
    return parts;
  }, [text, cmdNames]);

  useEffect(() => { setMenuIndex(0); }, [slashCtx?.query]);

  const autoGrow = (el) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  useEffect(() => {
    if (textareaRef.current) autoGrow(textareaRef.current);
  }, [text]);

  const selectCommand = (cmd) => {
    if (slashCtx) {
      const before = text.slice(0, slashCtx.start);
      const after = text.slice(cursorPos);
      const inserted = `/${cmd.name} `;
      setText(before + inserted + after);
      const newPos = before.length + inserted.length;
      setCursorPos(newPos);
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(newPos, newPos);
      });
    } else {
      setText(`/${cmd.name} `);
    }
    setMenuIndex(0);
    textareaRef.current?.focus();
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");

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
        ui.addOptimisticUserMessage(realId, t);
        setTimeout(() => { api.sendOrchestratorMessage(realId, t); }, 1500);
      } else {
        console.error("spawn failed:", r);
        alert("Failed to create orchestrator.");
      }
      return;
    }

    if (selected) {
      ui.addOptimisticUserMessage(selected.id, t);
      try { await live.sendToAgent(selected.id, t); }
      catch (e) { console.error("send failed:", e); }
      return;
    }

    const cwdFallback = ui.composer.cwd ?? live.recents[0] ?? null;
    if (!cwdFallback) { alert("Pick a folder first."); return; }
    const r = await live.spawnOrchestrator({ cwd: cwdFallback, model: ui.composer.model });
    if (r?.ok && r.body?.id) {
      const realId = r.body.id;
      ui.setSelectedId(realId);
      ui.addOptimisticUserMessage(realId, t);
      setTimeout(() => { api.sendOrchestratorMessage(realId, t); }, 1500);
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
        setText("");
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
          />
          <div className="c-row2">
            <div className="textarea-wrap">
              {overlayParts && (
                <div className="textarea-overlay" aria-hidden="true">
                  {overlayParts.map((p, i) =>
                    p.hl ? <span key={i} className="cmd-highlight">{p.text}</span>
                         : <span key={i}>{p.text}</span>
                  )}
                </div>
              )}
              <textarea
                ref={textareaRef}
                rows="1"
                placeholder="Type / for commands"
                className={overlayParts ? "has-command" : ""}
                value={text}
                onChange={(e) => { setText(e.target.value); setCursorPos(e.target.selectionStart); }}
                onKeyDown={onKey}
              onKeyUp={(e) => setCursorPos(e.target.selectionStart)}
              onClick={(e) => setCursorPos(e.target.selectionStart)}
              />
            </div>
            <button className="submit" title="Send" onClick={send}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v5H4m3-3l-3 3 3 3" />
              </svg>
            </button>
          </div>
        </div>

        <ComposerControls live={live} />
      </div>
    </div>
  );
}
