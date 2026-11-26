import { Fragment } from "react";
import { renderMarkdown } from "../../../../lib/markdown.js";

// A draft's result, read-only, drawn by its kind (eos_domain::result_doc):
// a review with line comments, a mail, or a text. Agent-written text goes
// through the sanitised markdown; recipients are fixed by the blueprint and
// shown locked.

const EVENTS = { COMMENT: "Comment", APPROVE: "Approve", REQUEST_CHANGES: "Request changes" };

function Markdown({ text, className }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

// A comment's place (file and line), breakable only after a folder's slash
// so a narrow column never splits a name or its line number.
export function placeOf(meta) {
  if (!meta?.path) return null;
  const parts = meta.path.split("/");
  const line = meta.line != null ? `:${meta.line}` : "";
  return parts.map((part, i) => (i < parts.length - 1 ? <Fragment key={i}>{part}/<wbr /></Fragment> : <Fragment key={i}>{part}{line}</Fragment>));
}

const partsOf = (doc, prefix) => doc.parts.filter((p) => p.key.startsWith(prefix));
const textOf = (doc, key) => doc.parts.find((p) => p.key === key)?.text;

function Review({ doc }) {
  const event = textOf(doc, "event");
  const summary = textOf(doc, "summary");
  const comments = partsOf(doc, "c:");
  return (
    <div className="eos-result">
      {event && <p className={`eos-result__event eos-result__event--${event.toLowerCase()}`}>{EVENTS[event] ?? event}</p>}
      {summary && <Markdown className="eos-result__text" text={summary} />}
      {comments.length > 0 && (
        <ol className="eos-result__comments" aria-label="Line comments">
          {comments.map((c) => (
            <li key={c.key} className="eos-result__comment">
              <span className="eos-result__place">{placeOf(c.meta)}</span>
              <Markdown className="eos-result__text" text={c.text} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Mail({ doc }) {
  const to = partsOf(doc, "to:");
  return (
    <div className="eos-result">
      {to.length > 0 && (
        <p className="eos-result__to">
          To {to.map((r) => <span key={r.key} className="eos-chip eos-result__locked">{r.text}</span>)}
          <span className="eos-result__fixed">Fixed in the blueprint</span>
        </p>
      )}
      <p className="eos-result__subject">{textOf(doc, "subject")}</p>
      {partsOf(doc, "p:").map((p) => <p key={p.key} className="eos-result__para">{p.text}</p>)}
    </div>
  );
}

// Where a note to the user goes, said as mail says its recipients.
const TO_YOU = { push: "as a notification", sms: "by text message" };

function Text({ doc }) {
  const how = doc.kind === "text" ? TO_YOU[doc.channel] : null;
  return (
    <div className="eos-result">
      {how && (
        <p className="eos-result__to eos-result__to--ruled">
          To <span className="eos-chip eos-result__locked">you</span>
          <span className="eos-result__fixed">{how}</span>
        </p>
      )}
      {doc.parts.map((p) => <Markdown key={p.key} className="eos-result__text" text={p.text} />)}
    </div>
  );
}

const BY_KIND = { "github.review": Review, mail: Mail };

// The draft as the user left it (saved edits), else as the run made it. The
// gate puts the run's ResultDoc in the item's payload as `doc`.
export function draftDoc(detail) {
  const doc = detail.working ?? detail.payload?.doc;
  return Array.isArray(doc?.parts) ? doc : null;
}

// A ResultDoc by its kind; a run's result view draws it too.
export function DocView({ doc }) {
  const Kind = BY_KIND[doc.kind] ?? Text;
  return <Kind doc={doc} />;
}

export function ResultView({ detail }) {
  const doc = draftDoc(detail);
  if (!doc) return <p className="eos-note">{detail.item.summary}</p>;
  return <DocView doc={doc} />;
}
