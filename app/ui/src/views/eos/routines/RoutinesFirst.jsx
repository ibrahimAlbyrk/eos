import { Section } from "../frame.jsx";
import { NEW_STARTERS } from "../blueprint/words.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { RoutineGlyph } from "./RoutineGlyph.jsx";

// The way from a sentence to a routine that runs, drawn as a beat that has
// not begun: the user's words are where it starts, the rest lies ahead.
const WAY = [
  ["Say it", "in your own words"],
  ["Eos writes it", "a blueprint you can change"],
  ["Try it", "on real past items"],
  ["Start it", "and it runs when it should"],
];

// What each starter sentence would make, by the sentence New routine offers.
const MAKES = {
  [NEW_STARTERS[0]]: ["eye", "A review of each one, drafted for you to send."],
  [NEW_STARTERS[1]]: ["paper", "One page each morning of what is new in what you follow."],
  [NEW_STARTERS[2]]: ["mail", "Your mail sorted by what it needs, the replies waiting for you."],
  [NEW_STARTERS[3]]: ["pulse", "A note the moment it fails, with what changed since it last passed."],
};

const ARROW = "M3 8h9.5M8.5 4l4 4-4 4";
const newRoutine = (say) => openLocation(buildLocation({ screen: "new-routine", say }));

// Routines with none yet, as a first step: what a routine is, said as Home
// greets; the way from a sentence to a routine that runs; and sentences to
// start from, each opening New routine with it written in.
export function RoutinesFirst() {
  return (
    <div className="eos-first">
      <header className="eos-first__head">
        <p className="eos-label">Routines</p>
        <h2 className="eos-first__ask">No routines yet.</h2>
        <p className="eos-first__dim">Say once what Eos should take care of, and it runs when it should.</p>
      </header>

      <div className="eos-beat eos-beat--ahead" aria-hidden="true">
        <ol className="eos-beat__line">
          {WAY.map(([tag, word], i) => (
            <li key={tag} className={i === 0 ? "eos-beat__stop eos-beat__stop--active eos-beat__stop--newest" : "eos-beat__stop eos-beat__stop--ahead"}>
              <span className="eos-beat__mark">
                <span className="eos-beat__dot" />
                <span className="eos-beat__tag">{tag}</span>
                <span className="eos-beat__word">{word}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="eos-sr">Say it in your own words, Eos writes a blueprint you can change, you try it on real past items, then start it.</p>

      <Section id="eos-first-starts" label="Start from one of these" aside={<button type="button" className="eos-link" onClick={() => newRoutine()}>Or say your own</button>}>
        <ul className="eos-first__list">
          {NEW_STARTERS.map((say) => {
            const [icon, line] = MAKES[say];
            return (
              <li key={say}>
                <button type="button" className="eos-first__row" onClick={() => newRoutine(say)}>
                  <span className="eos-rtable__mark" aria-hidden="true">
                    <RoutineGlyph icon={icon} name={say} size={14} part="eos-rtable" />
                  </span>
                  <span className="eos-first__words">
                    <span className="eos-first__say">{say}</span>
                    <span className="eos-first__line">{line}</span>
                  </span>
                  <svg className="eos-first__go" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={ARROW} /></svg>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
