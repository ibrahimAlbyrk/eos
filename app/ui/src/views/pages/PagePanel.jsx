import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { useOriginPane } from "../../state/paneScope.js";
import { pushTextHandoff } from "../../state/browserComposerHandoff.js";
import { DELETED, removePage, savePage, usePage } from "../../state/pagesStore.js";
import { pageIdOf } from "../../lib/panelTabs.js";
import { mergePageBody } from "../../lib/pageMerge.js";
import { countTasks } from "../../lib/pageTasks.js";
import { fmtTimeAgo } from "../../lib/format.js";
import { notify } from "../../lib/notify.js";
import { nameOf } from "../../lib/agentName.js";
import { useClockTick } from "../../hooks/useClockTick.js";
import { PageEditor } from "./PageEditor.jsx";
import { TAB_ICONS } from "../agents/panes/panelTabMeta.jsx";

// A page tab: title, who it belongs to and who touched it last, a block
// toolbar, and the live-preview editor. Edits autosave (debounced) against the
// rev they started from; when an agent changed the page meanwhile the daemon
// answers 409 and the two versions are merged line by line (the user's text
// wins a same-line clash). A newer version arriving while nothing is unsaved
// simply replaces the editor content.

const SAVE_DELAY_MS = 500;

export function PagePanel({ live, tabId }) {
  const ui = useUi();
  const id = pageIdOf(tabId);
  const page = usePage(id);
  if (page === DELETED) {
    return (
      <div className="empty-state">
        <span className="empty-state__icon">{TAB_ICONS.page}</span>
        <span className="empty-state__title">This page was deleted</span>
        <button className="empty-state__action" onClick={() => ui.closeTab(tabId)}>Close tab</button>
      </div>
    );
  }
  if (!page) return <div className="pg" aria-busy="true" />;
  return <PageDocument key={id} page={page} live={live} tabId={tabId} />;
}

function PageDocument({ page, live, tabId }) {
  const ui = useUi();
  const composerPane = useOriginPane();
  const editorRef = useRef(null);
  const titleRef = useRef(null);
  const [title, setTitle] = useState(page.title);
  const [status, setStatus] = useState("saved"); // "saved" | "saving" | "error"
  const draft = useRef({ title: page.title, body: page.body });
  const base = useRef({ rev: page.rev, title: page.title, body: page.body });
  const dirty = useRef(false);
  const saving = useRef(false);
  const timer = useRef(null);

  const workers = live?.workers ?? [];
  const agent = page.agentId ? workers.find((w) => w.id === page.agentId) ?? null : null;
  const target = agent ?? (ui.selectedId ? workers.find((w) => w.id === ui.selectedId) ?? null : null);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (!dirty.current || saving.current) return;
    saving.current = true;
    dirty.current = false;
    setStatus("saving");
    const r = await savePage(page.id, draft.current, base.current.rev);
    saving.current = false;
    if (r.ok) {
      base.current = { rev: r.page.rev, title: r.page.title, body: r.page.body };
    } else if (r.conflict) {
      // An agent wrote meanwhile: replay our edits onto its version and save again.
      const remote = r.conflict;
      const merged = mergePageBody(base.current.body, draft.current.body, remote.body);
      if (merged === null) notify.warning("This page changed while you were typing — your version was kept.");
      const body = merged ?? draft.current.body;
      const nextTitle = draft.current.title !== base.current.title ? draft.current.title : remote.title;
      base.current = { rev: remote.rev, title: remote.title, body: remote.body };
      draft.current = { title: nextTitle, body };
      editorRef.current?.setDoc(body);
      setTitle(nextTitle);
      dirty.current = body !== remote.body || nextTitle !== remote.title;
    } else {
      dirty.current = true;
      setStatus("error");
      return;
    }
    if (dirty.current) timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
    else setStatus("saved");
  }, [page.id]);

  const schedule = useCallback(() => {
    dirty.current = true;
    setStatus("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [save]);

  // Flush on close / tab switch.
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (dirty.current) void flushPage(page.id, draft.current, base.current);
  }, [page.id]);

  // A newer version (an agent's edit) with nothing unsaved here: take it.
  useEffect(() => {
    if (page.rev <= base.current.rev || dirty.current || saving.current) return;
    base.current = { rev: page.rev, title: page.title, body: page.body };
    draft.current = { title: page.title, body: page.body };
    setTitle(page.title);
    editorRef.current?.setDoc(page.body);
  }, [page]);

  // A fresh, untitled page starts in its title.
  useEffect(() => { if (!page.title && !page.body) titleRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pageRef = () => `page "${draft.current.title || "Untitled"}" (${page.id})`;
  const addToChat = (selection) => {
    const text = selection
      ? `From ${pageRef()}:\n${selection.split("\n").map((l) => `> ${l}`).join("\n")}\n`
      : `${pageRef()[0].toUpperCase()}${pageRef().slice(1)} `;
    pushTextHandoff(composerPane, text);
  };
  const handTasks = async (tasks) => {
    if (!target || !live?.sendToAgent) return;
    if (dirty.current) await save();
    const list = tasks.map((t) => `- [ ] ${t}`).join("\n");
    const text = `Tasks from ${pageRef()} — do ${tasks.length > 1 ? "them" : "it"}, then tick ${tasks.length > 1 ? "each" : "it"} on the page:\n${list}`;
    const r = await live.sendToAgent(target.id, text, { queueWhenBusy: true });
    if (r?.ok === false) notify.error(`Couldn't reach ${nameOf(target)}: ${r.body?.error ?? r.status}`);
  };
  const openTasks = () => draft.current.body.split("\n")
    .map((l) => l.match(/^\s*[-*+]\s+\[ \]\s+(.*\S)/)?.[1])
    .filter(Boolean);

  // Read by the editor at call time (a ref, so it never rebuilds).
  const actionsRef = useRef({});
  actionsRef.current = {
    project: page.project,
    canHand: Boolean(target && live?.sendToAgent),
    onHandTask: (task) => void handTasks([task]),
    hasOpenTasks: () => openTasks().length > 0,
    onHandAll: () => void handTasks(openTasks()),
    onAddToChat: composerPane ? addToChat : null,
  };

  const onTitle = (e) => {
    setTitle(e.target.value);
    draft.current = { ...draft.current, title: e.target.value };
    schedule();
  };
  const onBody = useCallback((body) => {
    draft.current = { ...draft.current, body };
    schedule();
  }, [schedule]);

  return (
    <div className="pg">
      <PageToolbar
        editorRef={editorRef}
        onAddToChat={composerPane ? () => addToChat(null) : null}
        onDelete={async () => {
          try { await removePage(page.id); ui.closeTab(tabId); } catch (e) { notify.error(e instanceof Error ? e.message : String(e)); }
        }}
        markdown={() => `# ${draft.current.title || "Untitled"}\n\n${draft.current.body}`}
      />
      <div className="pg-scroll">
        <div className="pg-doc">
          <input
            ref={titleRef}
            className="pg-title"
            value={title}
            placeholder="Untitled"
            aria-label="Page title"
            spellCheck={false}
            onChange={onTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter" || (e.key === "ArrowDown" && !e.shiftKey)) { e.preventDefault(); editorRef.current?.focusStart(); }
            }}
          />
          <PageMeta page={page} agent={agent} status={status} body={draft.current.body} />
          <PageEditor ref={editorRef} initialDoc={page.body} onChange={onBody} actionsRef={actionsRef} />
        </div>
      </div>
    </div>
  );
}

// The last save of an editor that is going away: one merge retry on a 409.
async function flushPage(id, draft, base) {
  const r = await savePage(id, draft, base.rev);
  if (!r.conflict) return;
  const body = mergePageBody(base.body, draft.body, r.conflict.body);
  if (body === null) { notify.warning("A page changed while you were typing — your last edit was not saved."); return; }
  const title = draft.title !== base.title ? draft.title : r.conflict.title;
  await savePage(id, { title, body }, r.conflict.rev);
}

function PageMeta({ page, agent, status, body }) {
  useClockTick();
  const tasks = countTasks(body);
  const by = page.updatedBy.kind === "agent" ? page.updatedBy.name ?? "an agent" : "you";
  return (
    <div className="pg-meta">
      {agent && (
        <span className="pg-meta__chip" title="The chat this page belongs to">
          <span className="pg-meta__dot" />{nameOf(agent)}
        </span>
      )}
      <span>{status === "saving" ? "Saving…" : status === "error" ? "Not saved — retrying on your next edit" : `Edited ${fmtTimeAgo(page.updatedAt)} by ${by}`}</span>
      {tasks.total > 0 && (
        <span className="pg-meta__progress">
          <span className="pg-meta__bar"><span style={{ width: `${(tasks.done / tasks.total) * 100}%` }} /></span>
          {tasks.done} of {tasks.total} done
        </span>
      )}
    </div>
  );
}

const TOOL_BLOCKS = [
  { kind: "todo", label: "To-do", icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="3" /><path d="m5.5 8.2 1.8 1.8 3.3-3.6" /></svg> },
  { kind: "h2", label: "Heading", icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"><path d="M4 3.5v9M12 3.5v9M4 8h8" /></svg> },
  { kind: "bullet", label: "Bulleted list", icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"><circle cx="3.5" cy="4.5" r=".9" fill="currentColor" /><circle cx="3.5" cy="11.5" r=".9" fill="currentColor" /><path d="M6.5 4.5h7M6.5 11.5h7" /></svg> },
  { kind: "code", label: "Code block", icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"><path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" /></svg> },
];

function PageToolbar({ editorRef, onAddToChat, onDelete, markdown }) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!menu) { setConfirm(false); return; }
    const close = (e) => { if (!e.target.closest?.(".pg-menu-wrap")) setMenu(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  // Keep the editor's selection: toolbar presses never take focus.
  const keep = (e) => e.preventDefault();
  return (
    <div className="pg-toolbar">
      <div className="pg-group" role="toolbar" aria-label="Insert">
        {TOOL_BLOCKS.map((b) => (
          <button key={b.kind} type="button" className="pg-tbtn" title={b.label} aria-label={b.label} onMouseDown={keep} onClick={() => editorRef.current?.block(b.kind)}>{b.icon}</button>
        ))}
        <button type="button" className="pg-tbtn" title="Mention a file" aria-label="Mention a file" onMouseDown={keep} onClick={() => editorRef.current?.mention()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"><circle cx="8" cy="8" r="2.5" /><path d="M10.5 8v1a1.8 1.8 0 0 0 3.5 0V8A6 6 0 1 0 11.5 13" /></svg>
        </button>
      </div>
      <span className="sp-spacer" />
      {onAddToChat && (
        <button type="button" className="pg-chat" onClick={onAddToChat}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3.5M4 7.5 8 3.5l4 4" /></svg>
          Add to chat
        </button>
      )}
      <span className="pg-menu-wrap">
        <button type="button" className={"pg-tbtn pg-tbtn--round" + (menu ? " on" : "")} aria-label="More" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12.5" cy="8" r="1.1" /></svg>
        </button>
        {menu && (
          <div className="pg-menu glass-pop" role="menu">
            <button type="button" role="menuitem" className="pg-menu__item" onClick={() => { void navigator.clipboard?.writeText(markdown()); setMenu(false); }}>Copy as Markdown</button>
            <button type="button" role="menuitem" className="pg-menu__item pg-menu__item--danger" onClick={() => (confirm ? onDelete() : setConfirm(true))}>
              {confirm ? "Click again to delete" : "Delete page"}
            </button>
          </div>
        )}
      </span>
    </div>
  );
}
