import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useUi } from "../../state/ui.jsx";
import { useOriginPane } from "../../state/paneScope.js";
import { queueUrl } from "../../state/browserPanelStore.js";
import { pushTextHandoff } from "../../state/browserComposerHandoff.js";
import { createPage, usePageList } from "../../state/pagesStore.js";
import { useSuggestions } from "../../state/browserHistoryStore.js";
import { subscribe as subscribeDiff, getSnapshot as getDiff, revalidate as revalidateDiff } from "../../state/diffStore.js";
import { useSubagents } from "../../state/subagentsStore.js";
import { explorer } from "../../state/explorerStore.js";
import { resolveOmnibox } from "../../lib/omnibox.js";
import { pageTabId } from "../../lib/panelTabs.js";
import { fmtTimeAgo } from "../../lib/format.js";
import { notify } from "../../lib/notify.js";
import { useBrowserSessionKey } from "../browser/useBrowserSessionKey.js";
import { usePageScope } from "../pages/usePageScope.js";
import { TAB_ICONS, TAB_KBD, TAB_LABELS } from "../agents/panes/panelTabMeta.jsx";

// New-tab launcher: one field (an address or a web search opens the browser;
// "#" finds pages, "@" files, "?" asks the agent), the panel's tools, the
// project's recent pages and the sites the browser visits most. Whatever it
// opens takes this tab's place (ui.replaceTab). `tabId` is null when it stands
// in for an empty panel — then it opens a tab instead.

const AGENT_TOOLS = ["review", "terminal", "files", "page", "chatfiles", "subagents"];
const SIGIL_CHIPS = [
  { sigil: "#", label: "Pages" },
  { sigil: "@", label: "Files" },
  { sigil: "?", label: "Ask the agent", agentOnly: true },
];
const RECENT_PAGES = 4;

const baseName = (p) => (p ? p.replace(/\/+$/, "").split("/").pop() : "");
const CHAT_ICON = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" /></svg>;

export function NewTabPanel({ live, tabId = null, tools = AGENT_TOOLS }) {
  const ui = useUi();
  const scope = usePageScope(live);
  const sessionKey = useBrowserSessionKey();
  const composerPane = useOriginPane();
  const [text, setText] = useState("");
  const inputRef = useRef(null);
  const mode = resolveOmnibox(text);

  // Ready to type when opened from the panel (the + button) — but never pull
  // focus out of the composer when a launcher merely shows up on load.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.closest?.(".side-panel")) inputRef.current?.focus();
  }, []);

  const pages = usePageList(scope.project);
  const recent = (pages ?? []).slice(0, RECENT_PAGES);
  const pageHits = mode?.kind === "pages" ? matchPages(pages ?? [], mode.query) : [];

  const open = (type) => ui.replaceTab(tabId, type);
  const openUrl = (url) => { queueUrl(sessionKey, url); open("browser"); };
  const openPage = (id) => open(pageTabId(id));
  const newPage = async (title = "") => {
    try {
      const page = await createPage({ title, body: "", project: scope.project, agentId: scope.agentId });
      openPage(page.id);
    } catch (e) {
      notify.error(`Couldn't create the page: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const openTool = (type) => (type === "page" ? newPage() : open(type));

  const submit = (e) => {
    e.preventDefault();
    if (!mode) return;
    if (mode.kind === "url" || mode.kind === "search") openUrl(mode.url);
    else if (mode.kind === "pages") pageHits[0] ? openPage(pageHits[0].id) : newPage(mode.query);
    else if (mode.kind === "files") {
      if (scope.project) explorer.ensureRoot(scope.project);
      explorer.setSearchQuery(mode.query);
      open("files");
    } else if (mode.kind === "ask" && mode.query && scope.workerId) {
      pushTextHandoff(composerPane, mode.query);
      setText("");
    }
  };

  const chips = SIGIL_CHIPS.filter((c) => !c.agentOnly || scope.workerId);
  const pickSigil = (sigil) => { setText(`${sigil}`); inputRef.current?.focus(); };

  return (
    <div className="nt">
      <div className="nt-inner">
        <form className="nt-search" onSubmit={submit}>
          <label className="nt-field">
            <svg className="nt-field__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"><circle cx="7.2" cy="7.2" r="4.3" /><path d="m10.5 10.5 3 3" /></svg>
            <input
              ref={inputRef}
              className="nt-field__input"
              value={text}
              placeholder="Search or enter a URL"
              spellCheck={false}
              aria-label="Search or enter a URL"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && text) { e.preventDefault(); setText(""); } }}
            />
            {text && (
              <button type="button" className="nt-field__clear" aria-label="Clear" onClick={() => { setText(""); inputRef.current?.focus(); }}>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
              </button>
            )}
          </label>
          {mode ? (
            <ModeHint mode={mode} pageHits={pageHits} onOpenPage={openPage} hasAgent={Boolean(scope.workerId)} />
          ) : (
            <div className="nt-chips">
              {chips.map((c) => (
                <button key={c.sigil} type="button" className="nt-chip" onClick={() => pickSigil(c.sigil)}>
                  <span className="nt-chip__sigil">{c.sigil}</span>{c.label}
                </button>
              ))}
            </div>
          )}
        </form>

        <section className="nt-section" aria-label="Tools">
          <h2 className="nt-label">Tools</h2>
          <div className="nt-tools">
            {tools.filter((t) => t !== "browser").map((type) => (
              <button key={type} type="button" className="nt-tool" onClick={() => openTool(type)}>
                <span className="nt-tool__icon">{TAB_ICONS[type]}</span>
                <span className="nt-tool__text">
                  <span className="nt-tool__label">{TAB_LABELS[type]}</span>
                  <ToolMeta type={type} scope={scope} />
                </span>
                {TAB_KBD[type] && <kbd className="nt-kbd">{TAB_KBD[type]}</kbd>}
              </button>
            ))}
          </div>
        </section>

        {recent.length > 0 && (
          <section className="nt-section" aria-label="Pages">
            <h2 className="nt-label">Pages</h2>
            <div className="nt-pages">
              {recent.map((p) => <PageRow key={p.id} page={p} onOpen={() => openPage(p.id)} />)}
            </div>
          </section>
        )}

        <Suggested onOpen={openUrl} />
      </div>
    </div>
  );
}

function matchPages(pages, query) {
  const q = query.toLowerCase();
  return pages.filter((p) => !q || p.title.toLowerCase().includes(q) || p.excerpt.toLowerCase().includes(q)).slice(0, 6);
}

// Under the field while typing: what Enter will do (and, for "#", the matches).
function ModeHint({ mode, pageHits, onOpenPage, hasAgent }) {
  if (mode.kind === "pages") {
    return (
      <div className="nt-results">
        {pageHits.map((p, i) => <PageRow key={p.id} page={p} active={i === 0} onOpen={() => onOpenPage(p.id)} />)}
        {pageHits.length === 0 && <Hint icon={TAB_ICONS.page} text={mode.query ? `New page “${mode.query}”` : "New page"} active />}
      </div>
    );
  }
  const text = {
    url: `Open ${mode.url}`,
    search: `Search the web for “${mode.query}”`,
    files: mode.query ? `Find files matching “${mode.query}”` : "Browse files",
    ask: hasAgent ? (mode.query ? "Put it in the composer" : "Type a question for the agent") : "No agent in this pane",
  }[mode.kind];
  const icon = { url: TAB_ICONS.browser, search: TAB_ICONS.browser, files: TAB_ICONS.files, ask: CHAT_ICON }[mode.kind];
  return <div className="nt-results"><Hint icon={icon} text={text} active /></div>;
}

function Hint({ icon, text, active }) {
  return (
    <div className={"nt-result" + (active ? " is-active" : "")}>
      <span className="nt-result__icon">{icon}</span>
      <span className="nt-result__text">{text}</span>
      {active && <kbd className="nt-kbd">↵</kbd>}
    </div>
  );
}

function PageRow({ page, active, onOpen }) {
  const tasks = page.tasks.open + page.tasks.done;
  const meta = [
    tasks ? `${page.tasks.done}/${tasks} done` : null,
    page.updatedBy.kind === "agent" ? `${page.updatedBy.name ?? "agent"} · ${fmtTimeAgo(page.updatedAt)}` : fmtTimeAgo(page.updatedAt),
  ].filter(Boolean).join(" · ");
  return (
    <button type="button" className={"nt-result nt-page" + (active ? " is-active" : "")} onClick={onOpen}>
      <span className="nt-result__icon">{TAB_ICONS.page}</span>
      <span className="nt-page__text">
        <span className="nt-page__title">{page.title || "Untitled"}</span>
        {page.excerpt && <span className="nt-page__excerpt">{page.excerpt}</span>}
      </span>
      <span className="nt-page__meta">{meta}</span>
    </button>
  );
}

// A quiet second line per tool: live state where the panel has it cheaply.
function ToolMeta({ type, scope }) {
  if (type === "review") return <DiffMeta workerId={scope.workerId} />;
  if (type === "subagents") return <SubagentMeta workerId={scope.workerId} />;
  const folder = baseName(scope.project);
  const text = {
    terminal: folder ? `Shell in ${folder}` : "Shell",
    files: folder ? `Browse ${folder}` : "Open a folder",
    page: "Notes and tasks",
    chatfiles: "Shared in this chat",
  }[type];
  return text ? <span className="nt-tool__meta">{text}</span> : null;
}

const NO_DIFF = { changes: null };

function DiffMeta({ workerId }) {
  const snap = useSyncExternalStore(
    useCallback((cb) => (workerId ? subscribeDiff(workerId, cb) : () => {}), [workerId]),
    useCallback(() => (workerId ? getDiff(workerId) : NO_DIFF), [workerId]),
  );
  useEffect(() => { if (workerId) void revalidateDiff(workerId); }, [workerId]);
  const files = snap.changes?.files ?? [];
  if (!files.length) return <span className="nt-tool__meta">{workerId ? "No changes" : "Diff and history"}</span>;
  const add = files.reduce((n, f) => n + (f.insertions ?? 0), 0);
  const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <span className="nt-tool__meta nt-tool__meta--mono">
      <span className="nt-add">+{add}</span> <span className="nt-del">−{del}</span>
    </span>
  );
}

function SubagentMeta({ workerId }) {
  const runs = useSubagents(workerId);
  const running = (runs ?? []).filter((r) => r.status === "running").length;
  return <span className="nt-tool__meta">{running ? `${running} running` : "Background agents"}</span>;
}

function Suggested({ onOpen }) {
  const sites = useSuggestions();
  if (!sites.length) return null;
  return (
    <section className="nt-section" aria-label="Suggested">
      <h2 className="nt-label">Suggested</h2>
      <div className="nt-sites">
        {sites.map((s) => (
          <button key={s.url} type="button" className="nt-site" title={s.url} onClick={() => onOpen(s.url)}>
            <span className="nt-site__icon">
              {s.favicon ? <img src={s.favicon} alt="" width="20" height="20" /> : s.local ? TAB_ICONS.terminal : <span className="nt-site__mono">{s.host.replace(/^www\./, "")[0]?.toUpperCase()}</span>}
              {s.local && <span className="nt-site__live" aria-hidden="true" />}
            </span>
            <span className="nt-site__label">{s.local ? s.host : s.title || s.host}</span>
            <span className="nt-site__meta">{s.local ? "Local server" : s.count >= 3 ? "Visited often" : "Recent"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
