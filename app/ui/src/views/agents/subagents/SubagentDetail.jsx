import { useLayoutEffect, useMemo, useState } from "react";
import { modelName, EFFORT_LABELS } from "../../../lib/models.js";
import { groupTools, verbFor } from "../../../lib/messageParser.js";
import { cleanSubagentResult, isRunning, subagentStatusPhrase } from "../../../lib/subagentRuns.js";
import { useStickToBottom } from "../../../hooks/useStickToBottom.js";
import { ScrollHoldContext } from "../messages/scrollHoldContext.js";
import { DisclosureRow } from "../messages/DisclosureRow.jsx";
import { Collapse } from "../messages/Collapse.jsx";
import { ToolBlock } from "../messages/ToolBlock.jsx";
import { MessageRow } from "../messages/MessageRow.jsx";
import { MessageAssistant } from "../messages/MessageAssistant.jsx";
import { SubagentGlyph } from "./SubagentGlyph.jsx";

// Inner tools as transcript blocks (lone tools and grouped runs), in ToolItem's
// shape. Once the subagent is over nothing in it can still be running, whatever
// its last pulse said.
function toolBlocksOf(run) {
  const over = !isRunning(run);
  return groupTools((run.tools ?? []).map((t) => ({
    ...t,
    verb: verbFor(t.name),
    result: t.result ?? (t.done || over ? { text: "", isError: false } : null),
    running: t.running === true && !over,
  })));
}

// One subagent, opened from the list or the transcript: what it was asked, the
// tools it ran (the "Worked for …" disclosure) and its report.
export function SubagentDetail({ run, now, cwd, workers, onBack }) {
  const running = isRunning(run);
  // A live run opens on its work; a finished one leads with its report.
  const [open, setOpen] = useState(running);
  const stick = useStickToBottom({ threshold: 30 });
  // Once, on open: a live run follows its newest tool from the first frame.
  useLayoutEffect(() => {
    if (running) stick.write(Infinity, { pin: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const blocks = useMemo(() => toolBlocksOf(run), [run]);
  const result = cleanSubagentResult(run.result);
  const effort = run.effort ? EFFORT_LABELS[run.effort] ?? run.effort : null;
  const meta = [run.subagentType, modelName(run.model), effort].filter(Boolean).join(" · ");

  return (
    <>
      <div className="sa-detail__head">
        <button type="button" className="sa-back" onClick={onBack} aria-label="Back to subagents" title="Back">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8H3M7 4 3 8l4 4" /></svg>
        </button>
        <SubagentGlyph identity={run.identity} status={run.status} size={16} />
        <span className="sa-detail__name">{run.description}</span>
        {meta && <span className="sa-detail__meta">{meta}</span>}
      </div>
      <ScrollHoldContext.Provider value={stick.hold}>
        <div className="sa-detail__scroll" ref={stick.scrollerRef}>
          <div className="sa-detail__body" ref={stick.contentRef}>
            <DisclosureRow expanded={open} onToggle={() => setOpen((o) => !o)} className="sa-worked">
              <span className={running ? "ti-shimmer" : undefined}>{subagentStatusPhrase(run, now)}</span>
            </DisclosureRow>
            <Collapse open={open}>
              <div className="sa-work">
                {run.prompt && <p className="sa-prompt">{run.prompt}</p>}
                {blocks.length > 0 && (
                  <div className="sa-tools">
                    {blocks.map((b) => (
                      <ToolBlock key={(b.tool ?? b.tools[0]).id} block={b} cwd={cwd} workers={workers} />
                    ))}
                  </div>
                )}
              </div>
            </Collapse>
            {result ? (
              <>
                <div className="sa-detail__sep" />
                <MessageRow ts={run.endTs} copyText={result}><MessageAssistant text={result} /></MessageRow>
              </>
            ) : !running && <p className="sa-detail__note">No output captured.</p>}
          </div>
        </div>
      </ScrollHoldContext.Provider>
    </>
  );
}
