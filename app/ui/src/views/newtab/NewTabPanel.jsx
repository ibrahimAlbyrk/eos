import { useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { useOriginPane } from "../../state/paneScope.js";
import { queueUrl } from "../../state/browserPanelStore.js";
import { pushTextHandoff } from "../../state/browserComposerHandoff.js";
import { createPage, usePageList } from "../../state/pagesStore.js";
import { useSuggestions } from "../../state/browserHistoryStore.js";
import { explorer } from "../../state/explorerStore.js";
import { resolveOmnibox } from "../../lib/omnibox.js";
import { pageTabId } from "../../lib/panelTabs.js";
import { fmtTimeAgo } from "../../lib/format.js";
import { notify } from "../../lib/notify.js";
import { useBrowserSessionKey } from "../browser/useBrowserSessionKey.js";
import { usePageScope } from "../pages/usePageScope.js";
import { TAB_ICONS } from "../agents/panes/panelTabMeta.jsx";
import { getPanel } from "../../lib/panelRegistry.js";
import { shortcutLabel } from "../../lib/platform.js";
import { useBuiltinOn } from "../../plugins/pluginsStore.js";
import { BUILTIN_PLUGINS } from "../../shared/builtin-plugins.ts";

// New-tab launcher: one field (an address or a web search opens the browser;
// "#" finds pages, "@" files, "?" asks the agent), the panel's tools, the
// project's recent pages and the sites the browser visits most. Whatever it
// opens takes this tab's place (ui.replaceTab). `tabId` is null when it stands
// in for an empty panel — then it opens a tab instead.

const SIGIL_CHIPS = [
  { sigil: "#", label: "Pages" },
  { sigil: "@", label: "Files" },
  { sigil: "?", label: "Ask the agent", agentOnly: true },
];
const RECENT_PAGES = 4;

const CHAT_ICON = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" /></svg>;

export function NewTabPanel({ live, tabId = null, tools }) {
  const ui = useUi();
  const scope = usePageScope(live);
  const sessionKey = useBrowserSessionKey();
  const composerPane = useOriginPane();
  const [text, setText] = useState("");
  const inputRef = useRef(null);
  const mode = resolveOmnibox(text);
  const pagesOn = useBuiltinOn(BUILTIN_PLUGINS.pages);
  const browserOn = useBuiltinOn(BUILTIN_PLUGINS.browser);

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
    if (mode.kind === "url" || mode.kind === "search") { if (browserOn) openUrl(mode.url); }
    else if (mode.kind === "pages" && pagesOn) pageHits[0] ? openPage(pageHits[0].id) : newPage(mode.query);
    else if (mode.kind === "files") {
      if (scope.project) explorer.ensureRoot(scope.project);
      explorer.setSearchQuery(mode.query);
      open("files");
    } else if (mode.kind === "ask" && mode.query && scope.workerId) {
      pushTextHandoff(composerPane, mode.query);
      setText("");
    }
  };

  const chips = SIGIL_CHIPS.filter((c) => (!c.agentOnly || scope.workerId) && (pagesOn || c.sigil !== "#"));
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
            <ModeHint mode={mode} pageHits={pageHits} onOpenPage={openPage} hasAgent={Boolean(scope.workerId)} pagesOn={pagesOn} browserOn={browserOn} />
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
            {tools.map((type) => {
              const panel = getPanel(type);
              return panel && <ToolTile key={`${type}#${panel.rev}`} panel={panel} scope={scope} onOpen={() => openTool(type)} />;
            })}
          </div>
        </section>

        {pagesOn && recent.length > 0 && (
          <section className="nt-section" aria-label="Pages">
            <h2 className="nt-label">Pages</h2>
            <div className="nt-pages">
              {recent.map((p) => <PageRow key={p.id} page={p} onOpen={() => openPage(p.id)} />)}
            </div>
          </section>
        )}

        {browserOn && <Suggested onOpen={openUrl} />}
      </div>
    </div>
  );
}

function matchPages(pages, query) {
  const q = query.toLowerCase();
  return pages.filter((p) => !q || p.title.toLowerCase().includes(q) || p.excerpt.toLowerCase().includes(q)).slice(0, 6);
}

// Under the field while typing: what Enter will do (and, for "#", the matches).
function ModeHint({ mode, pageHits, onOpenPage, hasAgent, pagesOn, browserOn }) {
  const off = { pages: !pagesOn && "Pages are turned off (Settings › Plugins)", url: !browserOn && "The browser is turned off (Settings › Plugins)" };
  off.search = off.url;
  if (off[mode.kind]) return <div className="nt-results"><Hint icon={TAB_ICONS.browser} text={off[mode.kind]} /></div>;
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
      {active && <kbd className="nt-kbd">{shortcutLabel("return")}</kbd>}
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

// One launcher tile; its panel may hide it where it can't work (useAvailable).
function ToolTile({ panel, scope, onOpen }) {
  const { label, icon, kbd, launcher } = panel;
  const available = (launcher.useAvailable ?? alwaysAvailable)();
  if (!available) return null;
  return (
    <button type="button" className="nt-tool" onClick={onOpen}>
      <span className="nt-tool__icon">{icon}</span>
      <span className="nt-tool__text">
        <span className="nt-tool__label">{launcher.label ?? label}</span>
        {launcher.Meta && <launcher.Meta scope={scope} />}
      </span>
      {kbd && <kbd className="nt-kbd">{kbd}</kbd>}
    </button>
  );
}

const alwaysAvailable = () => true;

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
