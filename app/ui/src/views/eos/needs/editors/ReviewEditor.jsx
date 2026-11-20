import { Revert } from "./Revert.jsx";
import { joinSuggestion, partChanged, partOf, partsOf, splitSuggestion, withPart, withText } from "./editDoc.js";

// A review with line comments (Review.dc.html): the verdict, the summary and
// each finding with whether it goes, its text and its suggested code. A
// comment part is its whole text, which GitHub posts as it is, and its meta
// is where it sits (path, line, side): a finding's place stays as the run
// found it, and none is added here.

const EVENTS = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

function Finding({ original, doc, part, onChange }) {
  const included = Boolean(partOf(doc, part.key));
  const shown = partOf(doc, part.key) ?? part;
  const { body, code } = splitSuggestion(shown.text);
  const id = `edit-${part.key}`;
  const setText = (nextBody, nextCode) => onChange(withText(doc, part.key, joinSuggestion(nextBody, nextCode)));
  return (
    <li className={included ? "eos-edit__finding" : "eos-edit__finding eos-edit__finding--out"}>
      <div className="eos-edit__head">
        <label className="eos-edit__include">
          <input type="checkbox" checked={included} onChange={(e) => onChange(withPart(doc, original, part.key, e.target.checked))} />
          <span className="eos-result__place">{part.meta?.path}{part.meta?.line != null ? `:${part.meta.line}` : ""}</span>
        </label>
        <Revert
          shown={included && partChanged(doc, original, part.key)}
          what="comment"
          onRevert={() => onChange(withText(doc, part.key, part.text, part.meta))}
        />
      </div>
      {included && (
        <>
          <textarea id={id} className="eos-edit__text" aria-label="Comment" rows={4} value={body} onChange={(e) => setText(e.target.value, code)} />
          {code != null && (
            <textarea
              className="eos-edit__text eos-edit__code"
              aria-label="Suggested code"
              rows={Math.min(12, code.split("\n").length + 1)}
              value={code}
              onChange={(e) => setText(body, e.target.value)}
            />
          )}
        </>
      )}
    </li>
  );
}

export function ReviewEditor({ original, doc, onChange }) {
  const event = partOf(doc, "event");
  const summary = partOf(doc, "summary");
  const back = (key) => () => onChange(withText(doc, key, partOf(original, key).text));
  return (
    <div className="eos-edit">
      {event && (
        <div className="eos-edit__field">
          <div className="eos-edit__head">
            <span className="eos-edit__label" id="edit-event">Verdict</span>
            <Revert shown={partChanged(doc, original, "event")} what="verdict" onRevert={back("event")} />
          </div>
          <div className="eos-seg" role="radiogroup" aria-labelledby="edit-event">
            {EVENTS.map((e) => (
              <button key={e.value} type="button" role="radio" aria-checked={event.text === e.value} className="eos-seg__opt" onClick={() => onChange(withText(doc, "event", e.value))}>
                {e.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {summary && (
        <div className="eos-edit__field">
          <div className="eos-edit__head">
            <label className="eos-edit__label" htmlFor="edit-summary">Summary</label>
            <Revert shown={partChanged(doc, original, "summary")} what="summary" onRevert={back("summary")} />
          </div>
          <textarea id="edit-summary" className="eos-edit__text" rows={5} value={summary.text} onChange={(e) => onChange(withText(doc, "summary", e.target.value))} />
        </div>
      )}
      {partsOf(original, "c:").length > 0 && (
        <ol className="eos-edit__findings" aria-label="Line comments">
          {partsOf(original, "c:").map((part) => <Finding key={part.key} original={original} doc={doc} part={part} onChange={onChange} />)}
        </ol>
      )}
    </div>
  );
}
