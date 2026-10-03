import { useMemo } from "react";
import { diffWords } from "diff";
import { useUi } from "../../../state/ui.jsx";
import { DELETED, usePage } from "../../../state/pagesStore.js";
import { pageTabId } from "../../../lib/panelTabs.js";
import { countTasks } from "../../../lib/pageTasks.js";
import { fmtTimeAgo } from "../../../lib/format.js";
import { ClampedMarkdown } from "./WebToolCards.jsx";
import { FailureBanner } from "./ToolDetail.jsx";

// Views for the page tools (both MCP servers). Quick actions read as one rich
// line: a tick names the task and the page as chips with the page's progress;
// a listing opens to compact rows. Reads and writes open to a page card — the
// page's header with an Open button, and the change drawn in place (added
// lines, a word diff, the new page's content). Registered in ./toolViews.jsx.

const failed = (t) => t.result?.isError === true;

const DOC = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2.5h5.2L12 5.3v8.2H4z" /><path d="M9 2.5v3h3M6 8.5h4M6 11h2.8" /></svg>;
const DOC_NEW = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2.5h5.2L12 5.3v8.2H4z" /><path d="M8 7v4M6 9h4" /></svg>;
const PEN = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9.8 3.2 12.8 6.2 6 13H3v-3z" /><path d="m8.5 4.5 3 3" /></svg>;
const OPEN = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11 11 5M6 5h5v5" /></svg>;
const TICK = <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 8.5 3 3 6-7" /></svg>;

function resultJson(t) {
  try {
    return JSON.parse(t.result?.text ?? "");
  } catch {
    return null;
  }
}

// The page a call acted on: its input id, or the id create_page returned.
export function pageToolId(t) {
  return t.input?.id ?? resultJson(t)?.id ?? null;
}

// read_page's text: "# Title\n(page <id> · rev N · last edited <iso> by <who>)\n\n<body>".
function parseRead(text) {
  const m = /^# (.*)\n\((?:page \S+ · )?rev (\d+) · last edited (\S+) by (.+?)\)\n\n?([\s\S]*)$/.exec(text ?? "");
  return m ? { title: m[1], rev: Number(m[2]), editedAt: Date.parse(m[3]), by: m[4], body: m[5] } : null;
}

// The tools speak to the agent ("you" = the agent); the transcript speaks to the user.
const byForUser = (by) => (by === "the user" ? "you" : by === "you" ? "the agent" : by);

function useOpenPage(id) {
  const ui = useUi();
  return (e) => {
    e?.stopPropagation();
    if (id) ui.openPanel(pageTabId(id));
  };
}

// A page's live title (the store loads it once); `fallback` until it arrives.
function PageTitle({ id, fallback }) {
  const page = usePage(id);
  return (page && page !== DELETED && page.title) || fallback || "a page";
}

function PageChip({ id, fallback }) {
  const open = useOpenPage(id);
  return (
    <button type="button" className="ptl-chip" onClick={open} title="Open page">
      {DOC}
      <span className="ptl-chip__text"><PageTitle id={id} fallback={fallback} /></span>
    </button>
  );
}

// The page's checklist progress as dots (a count past ten).
function PageProgress({ id }) {
  const page = usePage(id);
  if (!page || page === DELETED) return null;
  const { total, done } = countTasks(page.body);
  if (!total) return null;
  const label = `${done} of ${total} done`;
  if (total > 10) return <span className="ptl-count" title={label}>{done}/{total}</span>;
  return (
    <span className="ptl-dots" role="img" aria-label={label} title={label}>
      {Array.from({ length: total }, (_, i) => <span key={i} className={"ptl-dot" + (i < done ? " on" : "")} />)}
    </span>
  );
}

// set_page_task: "Ticked [☑ task] on [page] ●●●○" — the whole story in the row.
function TaskLine({ tool }) {
  const id = tool.input?.id;
  const done = tool.input?.done !== false;
  if (!tool.input?.task) return null;
  return (
    <>
      <span className={"ptl-task" + (done ? " is-done" : "")}>
        <span className={"ptl-cb" + (done ? " on" : "")}>{done && TICK}</span>
        <span className="ptl-chip__text">{tool.input.task}</span>
      </span>
      {id && <span className="ptl-on">on</span>}
      {id && <PageChip id={id} />}
      {id && !tool.running && !failed(tool) && <PageProgress id={id} />}
    </>
  );
}

// list_pages: compact rows that open the page.
function ListDetail({ tool }) {
  const ui = useUi();
  if (failed(tool)) return <div className="tool-detail"><FailureBanner tool={tool} /></div>;
  const pages = resultJson(tool)?.pages ?? [];
  return (
    <div className="tool-detail ptl-list">
      {pages.map((p) => {
        const total = (p.openTasks ?? 0) + (p.doneTasks ?? 0);
        const meta = [total ? `${p.doneTasks}/${total}` : null, p.updatedAt ? fmtTimeAgo(Date.parse(p.updatedAt)) : null].filter(Boolean).join(" · ");
        return (
          <button key={p.id} type="button" className="ptl-row" onClick={() => ui.openPanel(pageTabId(p.id))}>
            {DOC}
            <span className="ptl-row__title">{p.title}</span>
            {p.excerpt && <span className="ptl-row__excerpt">{p.excerpt}</span>}
            <span className="ptl-row__meta">{meta}</span>
          </button>
        );
      })}
    </div>
  );
}

function PageCard({ id, icon = DOC, tone, title, meta, badge, children }) {
  const open = useOpenPage(id);
  return (
    <div className="tool-detail pgc-detail">
      <div className={"web-card pgc" + (tone ? ` pgc--${tone}` : "")}>
        <div className="pgc-head">
          <span className="pgc-tile">{icon}</span>
          <span className="pgc-titles">
            <span className="pgc-title">{title}</span>
            {meta && <span className="pgc-meta">{meta}</span>}
          </span>
          {badge && <span className="pgc-badge">{badge}</span>}
          {id && <button type="button" className="pgc-open" onClick={open}>{OPEN}Open page</button>}
        </div>
        <div className="web-sep" />
        <div className="pgc-body">{children}</div>
      </div>
    </div>
  );
}

function Failed({ tool, children }) {
  return (
    <div className="tool-detail pgc-detail">
      <div className="web-card pgc pgc--failed">
        <div className="pgc-body">
          <FailureBanner tool={tool} />
          {children}
        </div>
      </div>
    </div>
  );
}

function ReadDetail({ tool }) {
  const read = useMemo(() => parseRead(tool.result?.text), [tool.result?.text]);
  if (failed(tool)) return <Failed tool={tool} />;
  if (!read) return null;
  const meta = `rev ${read.rev} · edited ${Number.isFinite(read.editedAt) ? fmtTimeAgo(read.editedAt) : ""} by ${byForUser(read.by)}`;
  return (
    <PageCard id={tool.input?.id} title={read.title || "Untitled"} meta={meta}>
      {read.body.trim() ? <ClampedMarkdown text={read.body} moreLabel="Show full page" /> : <span className="pgc-empty">Empty page</span>}
    </PageCard>
  );
}

function CreateDetail({ tool }) {
  if (failed(tool)) return <Failed tool={tool} />;
  const body = tool.input?.body ?? "";
  return (
    <PageCard id={pageToolId(tool)} icon={DOC_NEW} tone="new" title={tool.input?.title || "Untitled"} meta="New page · linked to this chat" badge="New">
      {body.trim() ? <ClampedMarkdown text={body} moreLabel="Show full page" /> : <span className="pgc-empty">Empty page</span>}
    </PageCard>
  );
}

// One appended markdown line, drawn the way the page shows it.
function AddedLine({ line }) {
  const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  const bullet = !task && /^\s*[-*+]\s+(.*)$/.exec(line);
  const heading = !task && !bullet && /^#{1,6}\s+(.*)$/.exec(line);
  return (
    <div className="pgc-add">
      <span className="pgc-add__sign">+</span>
      {task && <span className={"ptl-cb" + (task[1] !== " " ? " on" : "")}>{task[1] !== " " && TICK}</span>}
      {bullet && <span className="pgc-bullet" />}
      <span className={heading ? "pgc-add__heading" : undefined}>{task?.[2] ?? bullet?.[1] ?? heading?.[1] ?? line}</span>
    </div>
  );
}

function AppendDetail({ tool }) {
  if (failed(tool)) return <Failed tool={tool} />;
  const id = tool.input?.id;
  const lines = (tool.input?.text ?? "").split("\n").filter((l) => l.trim());
  const rev = resultJson(tool)?.rev;
  const heading = tool.input?.under_heading;
  const meta = [heading ? `under ${heading}` : "at the end", rev ? `rev ${rev}` : null].filter(Boolean).join(" · ");
  return (
    <PageCard id={id} title={<PageTitle id={id} />} meta={meta} badge={`+${lines.length} ${lines.length === 1 ? "line" : "lines"}`}>
      <div className="pgc-added">{lines.map((l, i) => <AddedLine key={i} line={l} />)}</div>
    </PageCard>
  );
}

function EditDetail({ tool }) {
  const parts = useMemo(() => diffWords(tool.input?.old_text ?? "", tool.input?.new_text ?? ""), [tool.input?.old_text, tool.input?.new_text]);
  if (failed(tool)) {
    return (
      <Failed tool={tool}>
        {tool.input?.old_text && <div className="pgc-tried"><span className="pgc-meta">Tried to replace</span><code>{tool.input.old_text}</code></div>}
      </Failed>
    );
  }
  const id = tool.input?.id;
  const rev = resultJson(tool)?.rev;
  return (
    <PageCard id={id} icon={PEN} title={<PageTitle id={id} />} meta={["1 passage changed", rev ? `rev ${rev}` : null].filter(Boolean).join(" · ")}>
      <p className="pgc-diff">
        {parts.map((p, i) => (
          p.removed ? <del key={i}>{p.value}</del> : p.added ? <ins key={i}>{p.value}</ins> : <span key={i}>{p.value}</span>
        ))}
      </p>
    </PageCard>
  );
}

const titleOf = (t) => <PageTitle id={t.input?.id} fallback={parseRead(t.result?.text)?.title} />;

function listedLabel(t) {
  const n = resultJson(t)?.pages?.length;
  const q = t.input?.query;
  if (n === undefined) return q ? `pages for “${q}”` : "pages";
  const pages = `${n} ${n === 1 ? "page" : "pages"}`;
  return q ? `${pages} for “${q}”` : pages;
}

// tool name → view spec (ToolItem contract: label/runningLabel/headerBadge/expandable/Detail).
export const PAGE_TOOL_VIEWS = {
  list_pages: {
    label: (t) => ({ verb: "Listed", file: listedLabel(t) }),
    runningLabel: () => ({ verb: "Listing", file: "pages" }),
    expandable: (t) => failed(t) || (resultJson(t)?.pages?.length ?? 0) > 0,
    Detail: ListDetail,
  },
  read_page: {
    label: (t) => ({ verb: "Read", file: titleOf(t) }),
    runningLabel: (t) => ({ verb: "Reading", file: titleOf(t) }),
    expandable: (t) => failed(t) || Boolean(t.result),
    Detail: ReadDetail,
  },
  create_page: {
    label: (t) => ({ verb: "Created page", file: t.input?.title ?? "" }),
    runningLabel: (t) => ({ verb: "Creating page", file: t.input?.title ?? "" }),
    expandable: (t) => failed(t) || Boolean(t.result),
    Detail: CreateDetail,
  },
  append_to_page: {
    label: (t) => ({ verb: "Added to", file: titleOf(t) }),
    runningLabel: (t) => ({ verb: "Adding to", file: titleOf(t) }),
    expandable: (t) => failed(t) || Boolean(t.result),
    Detail: AppendDetail,
  },
  edit_page: {
    label: (t) => ({ verb: "Edited", file: titleOf(t) }),
    runningLabel: (t) => ({ verb: "Editing", file: titleOf(t) }),
    expandable: (t) => failed(t) || Boolean(t.result),
    Detail: EditDetail,
  },
  set_page_task: {
    label: (t) => ({ verb: t.input?.done === false ? "Reopened" : "Ticked", file: "" }),
    runningLabel: () => ({ verb: "Updating", file: "" }),
    headerBadge: (t) => <TaskLine tool={t} />,
    expandable: failed,
    Detail: ({ tool }) => <div className="tool-detail"><FailureBanner tool={tool} /></div>,
  },
};
