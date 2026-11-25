import { useEffect, useState } from "react";
import { notify } from "../../../lib/notify.js";
import { sendFeedback } from "../../../state/eos/pageStore.js";
import { Fact } from "../frame.jsx";
import { TellBar } from "./TellBar.jsx";
import { PAGE_NOTE } from "./words.js";

// "Good issue" and "Not today": said once per issue, then said back as a fact.
function Verdict({ issueId }) {
  const [said, setSaid] = useState(null);
  useEffect(() => setSaid(null), [issueId]);
  const say = async (verdict) => {
    const r = await sendFeedback(issueId, verdict);
    if (r.ok) setSaid(verdict);
    else notify.error(r.error, { title: "Eos did not hear that" });
  };
  if (said) return <Fact tone="ok" role="status">{said === "good" ? "Noted: a good issue." : "Noted: not today."}</Fact>;
  return (
    <>
      <button type="button" className="eos-btn" onClick={() => void say("good")}>Good issue</button>
      <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void say("not_today")}>Not today</button>
    </>
  );
}

// Under the sheet, on a hairline, the two things the reader can do: answer
// for this issue (how it was, fix its words), and change the layout every
// issue is printed in (what the layout is, a line to say what to change).
// `verdict`: the issue may still be judged; `edit`: { on, toggle } when its
// words can be fixed; `note`: the layout's own note; `onTell`: change it.
export function PageEnding({ row, verdict, edit, version, note, onTell, first = false }) {
  const issue = row && (verdict || edit);
  return (
    <section className={issue ? "eos-page-end" : "eos-page-end eos-page-end--layout"} aria-label="What to do with this page">
      {issue && (
        <div className="eos-page-end__part">
          <h2 className="eos-label eos-page-end__label">This issue</h2>
          {verdict && <p className="eos-page-end__ask">Was it a good one?</p>}
          <div className="eos-actions">
            {verdict && <Verdict issueId={row.id} />}
            {edit && (
              <button type="button" className="eos-btn eos-btn--quiet" aria-pressed={edit.on} onClick={edit.toggle}>
                {edit.on ? "Done editing" : "Edit its words"}
              </button>
            )}
          </div>
        </div>
      )}
      {onTell && (
        <div className="eos-page-end__part">
          <h2 className="eos-label eos-page-end__label">
            The layout
            {version != null && <span className="eos-page-end__ver">Version {version}</span>}
          </h2>
          {note && <p className="eos-page-end__note">{note}</p>}
          {first && <p className="eos-page-end__note">Its design is ready: say what to change before the first issue prints.</p>}
          <TellBar label="Tell Eos what to change about this page" onSend={onTell} />
          <p className="eos-page__note">{PAGE_NOTE}</p>
        </div>
      )}
    </section>
  );
}
