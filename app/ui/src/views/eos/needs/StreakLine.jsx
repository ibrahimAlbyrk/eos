import { useEffect } from "react";
import { loadFreedom, useFreedom } from "../../../state/eos/freedomStore.js";

// Sends in a row, unedited, that bring the offer of the next rung (03 G3, D8).
export const OFFER_AFTER = 10;

const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const counted = (n) => NUMBERS[n] ?? String(n);

// What the next rung lets the routine do, as the offer will put it.
const NEXT = {
  ask: "to start these without asking first",
  draft: "to send these on its own, then tell you",
  send_then_tell: "to send these on its own",
};

// The line beside a draft's actions (Review.dc.html): how far the routine's
// streak is from the offer of more freedom; null when no offer can come.
export function streakLine(freedom) {
  if (!freedom || freedom.offer === "never" || freedom.offer === "offered") return null;
  const next = NEXT[freedom.rung];
  const streak = freedom.streak;
  if (!next || !(streak > 0) || streak >= OFFER_AFTER) return null;
  const left = OFFER_AFTER - streak;
  const went = streak === 1 ? "The last one went out unedited." : `${counted(streak)} in a row went out unedited.`;
  return `${went} ${left === 1 ? "One more" : `${counted(left)} more`} and Eos will offer ${next}.`;
}

// The streak as marks: one per send, those that went out unedited solid,
// the one that brings the offer ringed in the accent.
export function Streak({ of, done }) {
  return (
    <span className="eos-streak" aria-hidden="true">
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={i < done ? "eos-streak__mark eos-streak__mark--done" : i === of - 1 ? "eos-streak__mark eos-streak__mark--offer" : "eos-streak__mark"} />
      ))}
    </span>
  );
}

// The routine's streak, read once and again on `inbox:freedom`.
export function StreakLine({ routineId }) {
  const freedom = useFreedom().byRoutine[routineId];
  useEffect(() => { if (routineId) void loadFreedom(routineId); }, [routineId]);
  const line = streakLine(freedom);
  if (!line) return null;
  return (
    <p className="eos-needs-streak">
      <Streak of={OFFER_AFTER} done={freedom.streak} />
      <span>{line}</span>
    </p>
  );
}
