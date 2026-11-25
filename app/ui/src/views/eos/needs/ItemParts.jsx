import { fmtTimeAgo } from "../../../lib/format.js";
import { shortcutLabel } from "../../../lib/platform.js";
import { itemTone } from "./words.js";

// The words under an item's title: where it stands, in a dimmer line of the
// lead's size. A run's ask says who asks for what; a guess about the user
// asks it back; the rest say their summary.
function nowOf(detail, routineName) {
  const { item, payload } = detail;
  if (item.kind === "permission") return `${routineName ?? "A run"} wants to use ${payload?.toolName ?? "a tool"}.`;
  if (item.kind === "about_you") return "Is this right about you?";
  return item.summary || null;
}

// A summary longer than this reads as a paragraph, not a second title.
const LONG = 96;

// An item leads as an object's page does: its routine and age as a label,
// its title, where it stands; then `children`, the facts about it now (sent,
// stale, answered elsewhere, reconnecting), each on its own line.
export function ItemLead({ detail, routineName, children }) {
  const now = nowOf(detail, routineName);
  const tone = itemTone(detail.item);
  const names = ["eos-rlead__now", (tone === "warn" || tone === "err") && `eos-rlead__now--${tone}`, now && now.length > LONG && "eos-rlead__now--long"];
  const facts = [children].flat().filter(Boolean);
  return (
    <header className="eos-rlead eos-needs-item__head">
      <p className="eos-label">{routineName ?? "Eos"}<span className="eos-needs-item__when">{fmtTimeAgo(detail.item.createdAt)}</span></p>
      <h2 className="eos-lead">{detail.item.title}</h2>
      {now && <p className={names.filter(Boolean).join(" ")}>{now}</p>}
      {facts.length > 0 && <div className="eos-needs-item__facts">{facts}</div>}
    </header>
  );
}

// What an answer does, where its button alone would not say.
const SAYS = {
  permission: "Allow once lets this one call go ahead; Eos asks again the next time.",
  run_start: "Run starts it on this now. Skip lets it pass without a run.",
  confirm_change: "Nothing changes until you confirm it.",
  freedom_offer: "You can take it back any time on the routine's page.",
  delivery_problem: "I sent it myself marks it sent without sending it again.",
};

// The answers: the item's own, the primary first and lit, then Later and
// Discard set apart at the right; under them what an answer does.
export function AnswerBar({ kind, actions, blocked, offline, onAct, lead, aside }) {
  return (
    <div className="eos-needs-answer">
      <div className="eos-actions eos-needs-item__actions">
        {lead}
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            className={a.primary ? "eos-btn eos-btn--primary" : a.label === "Open" ? "eos-btn eos-btn--quiet" : "eos-btn"}
            disabled={blocked(a)}
            title={a.write && offline ? "Reconnecting…" : undefined}
            onClick={() => onAct(a)}
          >
            {a.label}{a.primary && <span className="eos-needs-key"> {shortcutLabel("mod+return")}</span>}
          </button>
        ))}
        {aside && <span className="eos-needs-answer__aside">{aside}</span>}
      </div>
      {SAYS[kind] && <p className="eos-needs-answer__says">{SAYS[kind]}</p>}
    </div>
  );
}

// An item still coming: the lead's shape, then its object's.
export function ItemGhost() {
  return (
    <div className="eos-needs-ghost" aria-busy="true" aria-label="Loading">
      <div className="eos-rlead eos-rlead--ghost">
        <span className="eos-skeleton__label" />
        <span className="eos-rlead__bar" />
        <span className="eos-rlead__bar eos-rlead__bar--dim" />
      </div>
      <span className="eos-needs-ghost__object" />
    </div>
  );
}
