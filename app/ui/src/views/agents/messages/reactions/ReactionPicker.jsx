import { MORE_EMOJI, QUICK_EMOJI } from "../../../../lib/reactions.js";

function Pick({ emoji, current, onPick }) {
  const on = emoji === current;
  return (
    <button
      type="button"
      className={"rx-pick" + (on ? " is-on" : "")}
      onClick={() => onPick(emoji)}
      aria-pressed={on}
      title={on ? "Remove reaction" : undefined}
    >
      {emoji}
    </button>
  );
}

// The top of a message's right-click bar: six quick emoji and a "+" that opens
// the rest below them. `current` is the user's reaction on the message; picking
// it again takes it back (the caller decides, onPick gets the emoji either way).
export function ReactionPicker({ current, onPick, more, onToggleMore }) {
  return (
    <>
      <div className="rx-quick" role="group" aria-label="React">
        {QUICK_EMOJI.map((e) => <Pick key={e} emoji={e} current={current} onPick={onPick} />)}
        <button
          type="button"
          className={"rx-pick rx-more" + (more ? " is-open" : "")}
          onClick={onToggleMore}
          aria-expanded={more}
          title="More emoji"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      {more && (
        <div className="rx-grid" role="group" aria-label="More emoji">
          {MORE_EMOJI.map((e) => <Pick key={e} emoji={e} current={current} onPick={onPick} />)}
        </div>
      )}
      <div className="rx-sep" />
    </>
  );
}
