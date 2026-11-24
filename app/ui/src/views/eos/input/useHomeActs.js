import { useRef, useState } from "react";
import { makeRoutine, sayToArchitect } from "../../../state/eos/blueprintStore.js";
import { addHomeRuns, addOnce } from "../../../state/eos/homeRunsStore.js";
import { loadRun, startOnce, startRun } from "../../../state/eos/runsStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { optionsOf, startBody } from "../runform/runFormModel.js";
import { homeForm } from "./runInput.js";

const blueprintOf = (routineId) => buildLocation({ screen: "routine", routineId, tab: "blueprint" });

// The words Make and Change carry: the sentence, with the links and paths
// handed in beside it. A text a door outside Eos brought (a selection, a
// share, a link's text) is not the user's: it never joins the words the
// architect takes as the user's instruction.
export const sentenceOf = (text, attachments, door = "home") =>
  [text, ...attachments.filter((a) => door === "home" || a.kind !== "text").map((a) => a.value)].filter(Boolean).join("\n");

// What Enter does at Home, once the intent is clear (08 §4.4, G16, G17):
// start the run (one per item), make a routine or change one through its
// architect, or do it once. `act` answers whether it took the text; a
// refusal stays on the line as `outcome` ({ repeat } with the earlier run,
// { devRun }, { dayCap }, { offline } or { error }).
// `door`: where the input sits (`home`, or the outside door that opened the
// quick panel).
export function useHomeActs(byId, door = "home") {
  const [outcome, setOutcome] = useState(null);
  const requestId = useRef(null);

  async function run(routine, form, { confirmRepeat = false, stoppable = false, door: from = door } = {}) {
    if (confirmRepeat || !requestId.current) requestId.current = crypto.randomUUID();
    const answer = await startRun(startBody(routine, optionsOf(routine), form, { door: from, clientRequestId: requestId.current, confirmRepeat }));
    if (answer.runs) {
      requestId.current = null;
      setOutcome(null);
      addHomeRuns(answer.runs.map((r) => ({ id: r.id, routineId: routine.id })), { stoppable });
      return true;
    }
    if (answer.repeat) await loadRun(answer.repeat);
    setOutcome({ ...answer, routine, form });
    return false;
  }

  async function once(text, attachments) {
    const answer = await startOnce({ text: text || "Do this", attachments, result: "usual", door });
    if (!answer.started) {
      setOutcome(answer);
      return false;
    }
    addOnce(answer.started);
    return true;
  }

  async function act(choice, { text, attachments }, form = null) {
    setOutcome(null);
    const routine = choice.routineId ? byId.get(choice.routineId) : null;
    switch (choice.intent) {
      case "run":
        return routine ? run(routine, form ?? homeForm(routine, choice.item ?? "")) : false;
      case "make": {
        const id = await makeRoutine(sentenceOf(text, attachments, door));
        openLocation(id ? blueprintOf(id) : "eos:/routines/new");
        return true;
      }
      case "change": {
        if (!routine) return false;
        const said = await sayToArchitect(routine.id, { text: sentenceOf(text, attachments, door) });
        openLocation(blueprintOf(routine.id));
        return said;
      }
      case "once":
        return once(text, attachments);
      default:
        return false;
    }
  }

  return {
    outcome,
    act,
    run,
    again: () => (outcome?.repeat ? run(outcome.routine, outcome.form, { confirmRepeat: true }) : Promise.resolve(false)),
    dismiss: () => setOutcome(null),
  };
}
