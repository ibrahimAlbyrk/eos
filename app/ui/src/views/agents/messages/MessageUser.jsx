import { useMemo } from "react";
import { api } from "../../../api/client.js";
import { ImageLightbox } from "../ImageLightbox.jsx";
import { labelTitle, parseAttachmentMessage, elementSummary } from "../../../lib/attachmentTokens.js";
import { segment, URL_RE } from "../../../lib/richText.jsx";
import { findSlashTokens } from "../../../lib/slashTokens.js";
import { PASTE_RE } from "../../../lib/pasteTokens.js";
import { listMarkers } from "../../../lib/markdownBlocks.js";
import { useSlashItems } from "../../../hooks/useSlashItems.js";
import { SlashPill } from "./SlashPill.jsx";
import { ReplyWho } from "./ReplyWho.jsx";

function basename(path) {
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  return p.split("/").pop() || p;
}

function shortenPaths(text, cwd) {
  if (!cwd || !text.includes(cwd)) return text;
  return text.replaceAll(cwd + "/", "@");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRules(labels, slashMap) {
  const rules = [
    {
      scan: (t) => listMarkers(t),
      render: (mark, key, data) => (
        <span key={key} className={data?.ordered ? "md-num" : `md-bullet md-d${Math.min(data?.depth ?? 0, 5)}`}>{mark}</span>
      ),
    },
    {
      match: URL_RE,
      render: (url, key) => (
        <a key={key} className="msg-link" href={url} rel="noreferrer">{url}</a>
      ),
    },
    {
      // Sent bubbles keep the collapsed-paste pill (displayText carries the
      // placeholder; the full text went to the agent only) — static, since the
      // content isn't retained here.
      match: PASTE_RE,
      render: (tok, key) => <span key={key} className="paste-pill">{tok}</span>,
    },
  ];
  if (labels.length) {
    const re = new RegExp(`(${labels.map(escapeRegExp).join("|")})`, "g");
    rules.push({
      match: re,
      render: (lbl, key) => <span key={key} className="att-hl">{lbl}</span>,
    });
  }
  if (slashMap.size) {
    rules.push({
      scan: (t) => findSlashTokens(t, slashMap),
      render: (tok, key) => <SlashPill key={key} text={tok} cmd={slashMap.get(tok.slice(1))} />,
    });
  }
  return rules;
}

// A click on a visual answer's send action, as the user's turn: a compact chip
// naming the view it came from (click → back to the view) and the action.
export function ViewReplyChip({ action, text, onJumpToView }) {
  const label = action.label || text;
  return (
    <div className="msg-user msg-user--action">
      <button
        type="button"
        className="gv-reply"
        onClick={() => onJumpToView?.(action.viewId)}
        title={action.viewTitle ? `Go to “${action.viewTitle}”` : "Go to the view"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </svg>
        {action.viewTitle && <span className="gv-reply-view">{action.viewTitle}</span>}
        <span className="gv-reply-label">{label}</span>
      </button>
    </div>
  );
}

export function MessageUser({ text, cwd, replyTo, agentName, onJumpToReply, action, onJumpToView }) {
  if (action?.viewId) return <ViewReplyChip action={action} text={text} onJumpToView={onJumpToView} />;
  return <MessageUserText text={text} cwd={cwd} replyTo={replyTo} agentName={agentName} onJumpToReply={onJumpToReply} />;
}

function MessageUserText({ text, cwd, replyTo, agentName, onJumpToReply }) {
  const slashItems = useSlashItems(cwd);
  const slashMap = useMemo(() => new Map(slashItems.map((c) => [c.name, c])), [slashItems]);
  const { display, attachments } = parseAttachmentMessage(text);
  const shortened = shortenPaths(display, cwd);
  const labels = attachments.map((a) => a.label).filter(Boolean);
  const images = attachments.filter((a) => a.kind === "image");
  const gallery = images.map((a, i) => ({
    src: api.imageUrl(a.path),
    alt: basename(a.path),
    title: labelTitle(a.label) ?? `Image #${i + 1}`,
  }));

  return (
    <div className="msg-user">
      {replyTo && (
        <button type="button" className="msg-reply-ref" onClick={() => onJumpToReply?.(replyTo.rowId)} title="Go to the original message">
          <svg className="msg-reply-ref-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 10 5 5-5 5" />
            <path d="M4 4v7a4 4 0 0 0 4 4h12" />
          </svg>
          <ReplyWho role={replyTo.role} agentName={agentName} />
          <span className="msg-reply-ref-text">{replyTo.excerpt}</span>
        </button>
      )}
      {attachments.length > 0 && (
        <div className="msg-attachments">
          {attachments.map((att) => (
            <div key={att.path} className={`msg-att msg-att-${att.kind}`} title={att.path}>
              {att.kind === "image" ? (
                <ImageLightbox gallery={gallery} index={images.indexOf(att)}>
                  <img src={api.imageUrl(att.path)} alt={basename(att.path)} className="msg-att-img" />
                </ImageLightbox>
              ) : att.kind === "element" ? (
                (() => {
                  const s = elementSummary(att.path) ?? { tag: labelTitle(att.label) ?? "element", detail: "" };
                  return (
                    <div className="msg-att-element-body">
                      <span className="msg-att-element-tag">{s.tag}</span>
                      {s.detail && <span className="msg-att-element-detail">{s.detail}</span>}
                    </div>
                  );
                })()
              ) : (
                <div className="msg-att-icon">
                  {att.kind === "folder" ? (
                    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3" />
                    </svg>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {shortened && <div className="b">{segment(shortened, buildRules(labels, slashMap))}</div>}
    </div>
  );
}
