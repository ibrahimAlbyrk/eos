// useConversationLists — the subagents and artifacts of a chat's WHOLE
// conversation, not just the paged window (lib/conversationLists.js). When the
// window holds every row (`partial` false) it is derived from the window's own
// blocks; otherwise the core's summaries cover the rest, asked again (coalesced)
// whenever a new row lands in the window. `windowSubagents` are the window's
// full subagents (tools, prompt, report): a detail view uses them when they hold
// all of a subagent, and asks the core for its rows only when they don't.

import { useEffect, useMemo } from "react";
import { collectSubagents } from "../lib/subagentRuns.js";
import { collectArtifacts } from "../lib/artifactLink.js";
import { mergeArtifacts, mergeSubagents, summarizeAll } from "../lib/conversationLists.js";
import { requestLists, useLists } from "../state/conversationListsStore.js";

export function useConversationLists(workerId, windowBlocks, { partial, windowEnd }) {
  const windowSubagents = useMemo(() => collectSubagents(windowBlocks), [windowBlocks]);
  const windowArtifacts = useMemo(() => collectArtifacts(windowBlocks), [windowBlocks]);
  const whole = useLists(partial ? workerId : null);

  useEffect(() => {
    if (partial && windowEnd > 0) requestLists(workerId, windowEnd);
  }, [workerId, partial, windowEnd]);

  // Until the summaries land, the window's own lists stand in.
  const subagents = useMemo(
    () => (partial && whole ? mergeSubagents(whole.subagents, windowSubagents) : summarizeAll(windowSubagents)),
    [partial, whole, windowSubagents],
  );
  const artifacts = useMemo(
    () => (partial && whole ? mergeArtifacts(whole.artifacts, windowArtifacts) : windowArtifacts),
    [partial, whole, windowArtifacts],
  );
  return { subagents, artifacts, windowSubagents };
}
