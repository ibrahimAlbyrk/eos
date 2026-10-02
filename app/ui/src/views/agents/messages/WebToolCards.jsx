import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { parseWebSearch, groupBySite, siteHue, splitUrl } from "../../../lib/webSources.js";
import { CopyButton, FailureBanner } from "./ToolDetail.jsx";

// Bodies for the web tools. WebSearch: a Spotlight-style query bar over the
// sources as site chips and the search's summary. WebFetch: a glass address bar
// over the prompt and what came back. Routing lives in ./toolViews.jsx.

const VISIBLE_SITES = 4;
// Prose taller than this folds behind a "Show full …" button (.web-prose.is-clamped)
const CLAMP_PX = 252;
// Folding only pays off when it hides more than a couple of lines.
const CLAMP_SLACK_PX = 48;

const SearchIcon = (
  <svg className="web-bar-icon" width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.75" />
    <path d="m10.5 10.5 3.25 3.25" />
  </svg>
);
const LockIcon = (
  <svg className="web-bar-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.6" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
  </svg>
);
const GlobeIcon = (
  <svg className="web-bar-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12" />
    <path d="M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2Z" />
  </svg>
);
const ExternalIcon = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2.5h4v4" />
    <path d="M13.5 2.5 8 8" />
    <path d="M12 9.5v3A1.5 1.5 0 0 1 10.5 14h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4h3" />
  </svg>
);
const DownChevron = (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3.5 6 4.5 4.5L12.5 6" />
  </svg>
);

function SiteTile({ name }) {
  return <span className="web-tile" style={{ "--h": siteHue(name) }}>{name[0]}</span>;
}

function ClampedMarkdown({ text, moreLabel }) {
  const ref = useRef(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const [tall, setTall] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // scrollHeight is the full height even while clamped, so one read per text is enough
  useLayoutEffect(() => {
    setTall((ref.current?.scrollHeight ?? 0) > CLAMP_PX + CLAMP_SLACK_PX);
  }, [html]);
  return (
    <div className="web-prose-wrap">
      <div ref={ref} className={"md-prose web-prose" + (tall && !expanded ? " is-clamped" : "")} dangerouslySetInnerHTML={{ __html: html }} />
      {tall && (
        <button type="button" className="web-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : moreLabel}
          {DownChevron}
        </button>
      )}
    </div>
  );
}

// A site with one link opens it; a site with several lists them under the chips.
function SiteChips({ sites }) {
  const [showAll, setShowAll] = useState(false);
  const [openName, setOpenName] = useState(null);
  const shown = showAll ? sites : sites.slice(0, VISIBLE_SITES);
  const hidden = sites.slice(shown.length);
  const open = shown.find((s) => s.name === openName);
  return (
    <>
      <div className="ws-sites">
        {shown.map((site) => (site.links.length === 1 ? (
          <a key={site.name} className="ws-site" href={site.links[0].url} target="_blank" rel="noreferrer" title={site.links[0].title || site.links[0].url}>
            <SiteTile name={site.name} />
            {site.name}
          </a>
        ) : (
          <button
            key={site.name}
            type="button"
            className={"ws-site" + (site === open ? " is-open" : "")}
            aria-expanded={site === open}
            onClick={() => setOpenName(site === open ? null : site.name)}
          >
            <SiteTile name={site.name} />
            {site.name}
            <span className="ws-site-count">{site.links.length}</span>
          </button>
        )))}
        {hidden.length > 0 && (
          <button type="button" className="ws-site ws-more" onClick={() => setShowAll(true)} title={hidden.map((s) => s.name).join(", ")}>
            <span className="ws-stack">
              {hidden.slice(0, 3).map((s) => <span key={s.name} className="web-dot" style={{ "--h": siteHue(s.name) }} />)}
            </span>
            +{hidden.length}
          </button>
        )}
      </div>
      {open && (
        <div className="ws-links">
          {open.links.map((link) => {
            const parts = splitUrl(link.url);
            return (
              <a key={link.url} className="ws-link" href={link.url} target="_blank" rel="noreferrer">
                <span className="ws-link-title">{link.title || parts.rest || parts.host}</span>
                <span className="ws-link-url">{parts.host + parts.rest}</span>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
}

export function WebSearchDetail({ tool }) {
  const text = tool.result?.text;
  const { links, summary } = useMemo(() => parseWebSearch(text), [text]);
  const sites = useMemo(() => groupBySite(links), [links]);
  const mode = tool.input?.mode;
  const failed = tool.result?.isError === true;
  const hasBody = sites.length > 0 || summary !== "";
  return (
    <div className="tool-detail web-detail">
      <div className="web-card">
        <div className={"web-bar ws-bar" + (tool.running ? " is-running" : "")}>
          {SearchIcon}
          <span className="ws-query">{tool.input?.query ?? ""}</span>
          {typeof mode === "string" && <span className="web-pill">{mode}</span>}
        </div>
        {failed && <FailureBanner tool={tool} />}
        {!failed && hasBody && (
          <>
            <div className="web-sep" />
            <div className="web-body">
              {sites.length > 0 && <SiteChips sites={sites} />}
              {summary && <ClampedMarkdown text={summary} moreLabel="Show full summary" />}
            </div>
          </>
        )}
        {!failed && !hasBody && tool.result && !tool.running && (
          <div className="web-empty">No sources came back for this query.</div>
        )}
      </div>
    </div>
  );
}

export function WebFetchDetail({ tool }) {
  const url = tool.input?.url ?? "";
  const parts = splitUrl(url);
  const prompt = tool.input?.prompt ?? "";
  const output = (tool.result?.text ?? "").trim();
  const failed = tool.result?.isError === true;
  return (
    <div className="tool-detail web-detail">
      <div className="web-card">
        <div className={"web-bar fetch-bar" + (tool.running ? " is-running" : "")}>
          {parts?.secure === false ? GlobeIcon : LockIcon}
          <span className="fetch-url">
            {parts ? <><span className="fetch-host">{parts.host}</span>{parts.rest}</> : url}
          </span>
          <CopyButton text={url} title="Copy URL" />
          {parts && (
            <a className="web-icon-btn" href={url} target="_blank" rel="noreferrer" title="Open in browser">{ExternalIcon}</a>
          )}
        </div>
        {failed && <FailureBanner tool={tool} />}
        <div className="web-body">
          {prompt && (
            <section className="web-section">
              <div className="web-label">Prompt</div>
              <p className="fetch-prompt">{prompt}</p>
            </section>
          )}
          {!failed && output && (
            <>
              {prompt && <div className="web-sep" />}
              <section className="web-section">
                <div className="web-label">Result</div>
                <ClampedMarkdown text={output} moreLabel="Show full result" />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
