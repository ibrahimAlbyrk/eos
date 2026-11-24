import { useState } from "react";
import { Revert } from "./Revert.jsx";
import { mailBody, withMailBody } from "./editDoc.js";

// The most a Slack post takes.
export const SLACK_MAX = 4000;

// A Slack message or a reply: its text, paragraph by paragraph. Where it
// goes is fixed in the blueprint and never edited here; Slack syntax is
// shown as typed, and the counter says how much room is left.
export function SlackEditor({ original, doc, onChange }) {
  const [text, setText] = useState(() => mailBody(doc));
  const change = (next) => {
    setText(next);
    onChange(withMailBody(doc, next));
  };
  const left = SLACK_MAX - text.length;
  const reply = doc.kind === "slack.reply";
  return (
    <div className="eos-edit">
      <div className="eos-edit__field">
        <div className="eos-edit__head">
          <label className="eos-edit__label" htmlFor="edit-slack">{reply ? "Reply" : "Message"}</label>
          <Revert shown={mailBody(doc) !== mailBody(original)} what="message" onRevert={() => change(mailBody(original))} />
        </div>
        <textarea id="edit-slack" className="eos-edit__text" rows={8} value={text} onChange={(e) => change(e.target.value)} />
        <p className={left < 0 ? "eos-edit__hint eos-edit__hint--over" : "eos-edit__hint"} aria-live="polite">
          {left < 0 ? `${-left} characters over Slack's limit` : `${left} characters left`}
          {" · "}Goes as you, with no link previews. @channel, @here and @everyone stay plain text.
        </p>
      </div>
    </div>
  );
}
