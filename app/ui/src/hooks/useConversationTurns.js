// useConversationTurns — turns for the WHOLE conversation, not just the paged
// event window. While older pages are unloaded, the prompt rows (+ the
// clear/rewind/recall markers that hide some) are fetched in full and run
// through the same parse pipeline; turns inside the window keep their rich
// preview/tool counts.

import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { buildBlocks, applyRewinds, applyClears, applyRecalls, sortBlocksByTs } from "../lib/messageParser.js";
import { deriveTurns, withOlderTurns } from "../lib/turnIndex.js";

const PROMPT_EVENT_TYPES = new Set([
  "user_message", "orchestrator_message",
  "conversation_cleared", "conversation_rewound", "message_recalled",
]);

export function useConversationTurns(workerId, events, windowTurns, { hasOlder, bootPromptOffset, bootTurn, keyOf }) {
  const [all, setAll] = useState({ workerId: null, turns: [] });

  // Refetch only when a new prompt or marker lands in the window.
  const promptSig = useMemo(() => {
    let max = 0;
    for (const e of events) if (PROMPT_EVENT_TYPES.has(e.type) && e.id > max) max = e.id;
    return max;
  }, [events]);

  useEffect(() => {
    if (!workerId || !hasOlder) return;
    let stale = false;
    api.getWorkerPromptEvents(workerId).then((rows) => {
      if (stale || !Array.isArray(rows)) return;
      const blocks = sortBlocksByTs(buildBlocks(applyRecalls(applyRewinds(applyClears(rows), { bootPromptOffset }))));
      setAll({ workerId, turns: deriveTurns(blocks, keyOf, bootTurn) });
    }).catch(() => {});
    return () => { stale = true; };
  }, [workerId, hasOlder, promptSig, bootPromptOffset, bootTurn, keyOf]);

  return useMemo(
    () => (hasOlder && all.workerId === workerId ? withOlderTurns(all.turns, windowTurns) : windowTurns),
    [all, workerId, hasOlder, windowTurns],
  );
}
