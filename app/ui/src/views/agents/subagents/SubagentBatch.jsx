import { SubagentLine } from "./SubagentLine.jsx";
import { SubagentGroup } from "./SubagentGroup.jsx";

// From this many on, a batch's names no longer read as one sentence.
const GROUP_AT = 4;

// One launch batch in the transcript: a few subagents read as a sentence of
// names, a crowd folds into a summary row that opens into a list.
export function SubagentBatch({ runs, workerId }) {
  return runs.length >= GROUP_AT
    ? <SubagentGroup runs={runs} workerId={workerId} />
    : <SubagentLine runs={runs} workerId={workerId} />;
}
