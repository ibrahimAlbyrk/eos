// Sources: a favicon stack + "4 sources · as of 19:12", expanding to the
// numbered list (entities cite them by number: source: 1 = the first).

import { useId, useState } from "react";
import { Icon } from "../icons.jsx";
import { useView } from "../../runtime/ViewContext.jsx";
import { attrBool } from "../../../../../../contracts/src/genui/attrs.ts";
import { MediaImg, Monogram } from "./media.jsx";
import { cls, hostOf, iconSrcs, openHref } from "./util.js";

function sourceSite(s) {
  return hostOf(s.site) || hostOf(s.url) || "";
}

function sourceTitle(s) {
  return s.title || s.name || sourceSite(s) || s.url || "Source";
}

function sourceHref(s) {
  if (typeof s.url === "string" && /^https?:\/\//i.test(s.url)) return s.url;
  const site = sourceSite(s);
  return site ? `https://${site}` : null;
}

// The newest `at` the agent gave ("19:12", "08.10"); the first one when they
// can't be compared.
function asOf(list) {
  const ats = list.map((s) => (typeof s.at === "string" ? s.at.trim() : "")).filter(Boolean);
  if (!ats.length) return "";
  return [...ats].sort().at(-1);
}

function Favicon({ view, source, size = 20 }) {
  const site = sourceSite(source);
  const name = site || sourceTitle(source);
  return (
    <span className="gv-src-fav" style={{ "--gv-fav-size": `${size}px` }}>
      <MediaImg srcs={iconSrcs(view, site)} alt="" fit="contain" className="gv-fill" fallback={<Monogram name={name} size={size} className="gv-fill" />} />
    </span>
  );
}

export function SourceList({ view, list, id }) {
  return (
    <ol className="gv-src-list" id={id}>
      {list.map((s, i) => {
        const href = sourceHref(s);
        const title = sourceTitle(s);
        const site = sourceSite(s);
        const body = (
          <>
            <span className="gv-src-num">{i + 1}</span>
            <Favicon view={view} source={s} size={16} />
            <span className="gv-src-title">
              {title}
              {s.note ? <span className="gv-dim"> · {s.note}</span> : null}
            </span>
            {site && site !== title ? <span className="gv-src-site">{site}</span> : null}
          </>
        );
        return (
          <li key={i}>
            {href ? (
              <a
                className="gv-src-row"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (openHref(view, href)) e.preventDefault();
                }}
              >
                {body}
              </a>
            ) : (
              <span className="gv-src-row">{body}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function Sources({ attrs = {} }) {
  const view = useView();
  const of = typeof attrs.of === "string" && attrs.of ? attrs.of : "sources";
  const raw = view?.data?.[of];
  const list = Array.isArray(raw) ? raw.filter((s) => s && typeof s === "object") : [];
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!list.length) return null;
  const compact = attrBool(attrs.compact);
  const stack = list.slice(0, 3);
  const more = list.length - stack.length;
  const when = asOf(list);
  const summary = `${list.length} source${list.length === 1 ? "" : "s"}${when ? ` · as of ${when}` : ""}`;
  return (
    <div className={cls("gv-sources", compact && "is-compact", open && "is-open")}>
      <button type="button" className="gv-src-bar" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen((v) => !v)}>
        <span className="gv-src-stack" aria-hidden="true">
          {stack.map((s, i) => <Favicon key={i} view={view} source={s} size={compact ? 16 : 20} />)}
          {more > 0 ? <span className="gv-src-more">+{more}</span> : null}
        </span>
        <span className="gv-src-summary">{summary}</span>
        <span className="gv-src-toggle">
          {compact ? null : <span>Sources</span>}
          <Icon name="chevron-right" size={13} stroke={2} className="gv-chev" />
        </span>
      </button>
      {open ? <SourceList view={view} list={list} id={listId} /> : null}
    </div>
  );
}
