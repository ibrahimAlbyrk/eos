import { useContext } from "react";
import { useUi } from "../../../state/ui.jsx";
import { routineRow, routinesNow } from "../../../state/eos/routinesStore.js";
import { open as openRunSheet } from "../../../state/eos/runSheetStore.js";
import { openEosRoute } from "../../eos/nav/eosNav.js";
import { stateChip } from "../../eos/run/words.js";
import { ChatContext } from "./chatContext.js";

// A run's state as the card says it: the card knows no start or end time.
export function cardState(state) {
  if (state === "done") return { tone: "ok", text: "Done" };
  return stateChip({ state }, 0);
}

// A routine's run in a chat (01's routine_note card): the routine, how far the
// run got and its headline; it opens the run in Eos.
export function RunLinkCard({ card }) {
  const ui = useUi();
  const chip = cardState(card.state);
  const openRun = () => openEosRoute(`eos:/runs/${encodeURIComponent(card.runId)}`, ui.setActiveView);
  return (
    <button type="button" className="run-link-card" onClick={openRun} aria-label={`Open the run of ${card.routineName}`}>
      <span className="run-link-card__top">
        <span className="run-link-card__name">{card.routineName || "Routine"}</span>
        <span className={`eos-status${chip.tone ? ` eos-status--${chip.tone}` : ""}`}>{chip.text}</span>
      </span>
      {card.headline && <span className="run-link-card__headline">{card.headline}</span>}
    </button>
  );
}

// What run_routine answered: started, proposed, or nothing yet.
export function runAnswer(tool) {
  if (tool.running || !tool.result || tool.result.isError) return null;
  try {
    const answer = JSON.parse(tool.result.text);
    return answer && typeof answer === "object" ? answer : null;
  } catch {
    return null;
  }
}

// An agent's proposal waits for the user's click: it opens the run sheet
// over the chat, filled with what the agent asked for. Nothing starts before Run.
function ProposalButton({ tool }) {
  const chat = useContext(ChatContext);
  const answer = runAnswer(tool);
  if (answer?.state !== "proposed") return null;
  const review = (e) => {
    e.stopPropagation();
    const row = routineRow(answer.routineId) ?? routinesNow().list?.find((r) => r.id === answer.routineId);
    const text = tool.input?.item?.trim();
    const kind = row?.takes?.kind ?? "text";
    const item = text ? { ...(/^https?:\/\//i.test(text) ? { kind, url: text } : { kind, text }), title: text, untrusted: true } : undefined;
    const input = { ...(item ? { item } : {}), ...(tool.input?.note ? { note: tool.input.note } : {}), ...(tool.input?.showOnly ? { result: "showOnly" } : {}) };
    openRunSheet({ routineId: answer.routineId, input, door: "chat", ...(chat ? { chat } : {}) });
  };
  return <button type="button" className="run-link-card__review" onClick={review}>Review and run</button>;
}

const routineWord = (t) => runAnswer(t)?.routine ?? t.input?.routine ?? "";

// How run_routine and list_routines read in the transcript.
export const RUN_TOOL_VIEWS = {
  run_routine: {
    label: (t) => ({ verb: runAnswer(t)?.state === "started" ? "Started" : "Proposed a run of", file: routineWord(t) }),
    runningLabel: (t) => ({ verb: "Asking to run", file: routineWord(t) }),
    headerBadge: (t) => <ProposalButton tool={t} />,
  },
  list_routines: {
    label: () => ({ verb: "Listed", file: "routines" }),
    runningLabel: () => ({ verb: "Listing", file: "routines" }),
  },
};
