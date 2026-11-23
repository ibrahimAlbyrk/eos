import { openLocation } from "../nav/eosNav.js";
import { learnedLine } from "./homeWords.js";

// "Eos learned 14 things this week. See them"; nothing in a week without.
export function LearnedLine({ weekly }) {
  const line = learnedLine(weekly);
  if (!line) return null;
  return (
    <p className="eos-home-learned">
      {line} <button type="button" className="eos-link" onClick={() => openLocation("eos:/memory?tab=work")}>See them</button>
    </p>
  );
}
