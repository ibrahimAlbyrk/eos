import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../../../api/client.js";
import { fileKind } from "../../../../lib/fileKind.js";
import { formatBytes, fmtTimeAgo } from "../../../../lib/format.js";
import { hasLocalScreen } from "../../../../lib/host.js";
import { renderMarkdown } from "../../../../lib/markdown.js";
import { isMarkdownPath } from "../../../../lib/markdownPreview.js";
import { displayParts } from "../../../../lib/pathLinks.js";
import { statPath } from "../../../../lib/pathStat.js";
import { FileIcon } from "../../../files/FileIcon.jsx";

const PEEK_W = 380;
const PEEK_H = 280;
const GAP = 8;
const EDGE = 8;
const LINES = 8;
const ENTRIES = 5;
const MD_CHARS = 1600;

// What the card shows under its header: a folder's first entries, an image, a
// markdown file's opening rendered, a text file's lines around the asked one.
async function loadBody(target) {
  if (target.type === "directory") {
    const { entries } = await api.listFiles(target.path);
    return { kind: "dir", entries };
  }
  const kind = fileKind(target.path);
  if (kind === "image") return { kind: "image" };
  if (kind !== "text") return null;
  const data = await api.readFile(target.path);
  if (data.binary || data.large || typeof data.content !== "string") return null;
  if (isMarkdownPath(target.path) && !target.line) return { kind: "md", html: renderMarkdown(data.content.slice(0, MD_CHARS)) };
  const all = data.content.split("\n");
  const first = target.line ? Math.max(1, target.line - 2) : 1;
  return { kind: "lines", first, lines: all.slice(first - 1, first - 1 + LINES) };
}

function PeekBody({ target, body }) {
  if (!body) return null;
  if (body.kind === "image") {
    return <div className="path-peek-body path-peek-img"><img src={api.imageUrl(target.path)} alt="" /></div>;
  }
  if (body.kind === "md") {
    return <div className="path-peek-body path-peek-md md-prose" dangerouslySetInnerHTML={{ __html: body.html }} />;
  }
  if (body.kind === "lines") {
    const last = target.endLine ?? target.line;
    return (
      <div className="path-peek-body path-peek-code">
        {body.lines.map((text, i) => {
          const n = body.first + i;
          const on = target.line != null && n >= target.line && n <= last;
          return (
            <div key={n} className={"path-peek-line" + (on ? " is-on" : "")}>
              <span className="path-peek-ln">{n}</span>
              <span className="path-peek-src">{text || " "}</span>
            </div>
          );
        })}
      </div>
    );
  }
  const shown = body.entries.slice(0, ENTRIES);
  const more = body.entries.length - shown.length;
  return (
    <div className="path-peek-body path-peek-dir">
      {shown.map((e) => (
        <div key={e.name} className="path-peek-entry"><FileIcon type={e.type} name={e.name} /><span>{e.name}</span></div>
      ))}
      {more > 0 && <div className="path-peek-entry is-more">+ {more} more</div>}
      {body.entries.length === 0 && <div className="path-peek-entry is-more">Empty folder</div>}
    </div>
  );
}

// Glass card over a path in the chat: what it is, a look inside, and the ways
// to open it. Fixed + portalled so the transcript's scroller can't clip it; it
// rises above the path and flips below when there is no room. Any scroll closes it.
export function PathPeek({ anchor, target, cwd, editor, onEnter, onLeave, onClose, onOpen, onEditor, onReveal, onMore }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = () => closeRef.current();
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, []);

  const [stat, setStat] = useState(null);
  const [body, setBody] = useState(null);
  useEffect(() => {
    let live = true;
    statPath(target.path).then((s) => { if (live) setStat(s ?? null); });
    loadBody(target).then((b) => { if (live) setBody(b); }, () => {});
    return () => { live = false; };
  }, [target]);

  const isDir = target.type === "directory";
  const { dir, base } = displayParts(target.path, { cwd, type: target.type });
  const meta = [
    dir.replace(/\/$/, "") || null,
    isDir ? (body?.kind === "dir" ? `${body.entries.length} items` : null) : stat ? formatBytes(stat.size) : null,
    stat ? `modified ${fmtTimeAgo(stat.mtimeMs)}` : null,
  ].filter(Boolean).join(" · ");

  const below = anchor.top - PEEK_H - GAP < EDGE;
  const left = Math.max(EDGE, Math.min(anchor.left - 6, window.innerWidth - PEEK_W - EDGE));
  const style = below ? { left, top: anchor.bottom + GAP } : { left, bottom: window.innerHeight - anchor.top + GAP };
  const local = hasLocalScreen();

  return createPortal(
    <div className={"path-peek glass-pop" + (below ? " below" : "")} style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="path-peek-head">
        <FileIcon type={target.type} name={base} />
        <div className="path-peek-title">
          <span className="path-peek-name">{base}</span>
          {meta && <span className="path-peek-meta">{meta}</span>}
        </div>
      </div>
      <PeekBody target={target} body={body} />
      <div className="path-peek-actions">
        <button type="button" className="path-peek-act is-primary" onClick={(e) => onOpen(target, e)}>
          {isDir ? "Open in Files" : "Open"}
        </button>
        {local && editor && (
          <button type="button" className="path-peek-act" onClick={() => onEditor(target)}>
            {editor.name}<span className="path-peek-kbd">⌥ click</span>
          </button>
        )}
        {local && (
          <button type="button" className="path-peek-act" onClick={() => onReveal(target)}>Reveal in Finder</button>
        )}
        <button
          type="button"
          className="path-peek-act path-peek-more"
          aria-label="More actions"
          onClick={(e) => onMore(target, e.currentTarget.getBoundingClientRect())}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
          </svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
