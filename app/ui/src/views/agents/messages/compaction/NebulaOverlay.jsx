import { useEffect, useLayoutEffect, useRef } from "react";
import { fmtTokens } from "../../../../lib/format.js";
import { setFx } from "../../../../state/compactionStore.js";
import { ASSEMBLING_CLASS } from "../CompactionCard.jsx";
import { createDirector } from "./director.js";
import { startNebula, startQuiet } from "./nebula.js";

// A compaction started more than this long ago was not watched live (reload or
// agent switch mid-run): the cloud appears without dissolving the transcript.
const LIVE_WINDOW_MS = 15_000;

function visibleBlocks(content, wrap) {
  const view = wrap.getBoundingClientRect();
  return [...content.children].filter((el) => {
    if (!el.matches("[data-bkey]")) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > view.top + 4 && r.top < view.bottom - 4 && r.height > 0;
  });
}

// Runs the compaction nebula over the transcript: starts when a compaction is
// pending, hands the dust to the boundary card when it completes, fades it out
// when it fails. Renders nothing itself — canvases and the label are appended
// to the messages frame, the transcript is hidden through data-compacting.
export function NebulaOverlay({ workerId, wrapRef, contentRef, status }) {
  const runRef = useRef(null);
  const pending = status.pending;
  const last = status.last;

  // Tear down on agent switch / unmount — never leave the transcript hidden.
  useEffect(() => () => {
    runRef.current?.nebula.destroy();
    runRef.current = null;
    const content = contentRef.current;
    if (content) delete content.dataset.compacting;
    setFx(workerId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  useLayoutEffect(() => {
    if (!pending || runRef.current?.id === pending.id) return;
    const wrap = wrapRef.current, content = contentRef.current;
    if (!wrap || !content) return;
    const live = Date.now() - pending.ts < LIVE_WINDOW_MS;
    setFx(workerId, { stage: "running", since: pending.ts });
    const onHide = () => { content.dataset.compacting = "hidden"; };
    const meta = `${fmtTokens(pending.payload.beforeTokens ?? 0)} tokens`;
    const quiet = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const d = createDirector();
    const nebula = quiet
      ? startQuiet(wrap.parentElement, { onHide, meta })
      : startNebula(d, { frame: wrap.parentElement, band: wrap, blocks: live ? visibleBlocks(content, wrap) : [], onHide, meta });
    runRef.current = { id: pending.id, nebula };
    // Keyed on the run's identity only: a re-render of the same run must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);

  useLayoutEffect(() => {
    const run = runRef.current;
    if (!run || run.ended || !last || last.type === "compaction_started") return;
    run.ended = true;
    const content = contentRef.current;
    const done = () => { if (runRef.current === run) runRef.current = null; };
    if (last.type === "compaction_failed") {
      setFx(workerId, null);
      if (content) content.dataset.compacting = "restoring";
      run.nebula.fail().finally(() => {
        if (content?.dataset.compacting === "restoring") delete content.dataset.compacting;
        done();
      });
      return;
    }
    // Completed: history has just folded away and the card rendered blank.
    if (content) delete content.dataset.compacting;
    const card = content?.querySelector(`[data-compaction-card="${last.id}"]`);
    if (!card) {
      run.nebula.destroy();
      setFx(workerId, null);
      done();
      return;
    }
    setFx(workerId, { stage: "assembling", cardId: last.id });
    run.nebula.complete(card, {
      assemblingClass: ASSEMBLING_CLASS,
      cardSeed: last.id,
      onSettle: () => setFx(workerId, { stage: "settling", cardId: last.id }),
      onReveal: () => setFx(workerId, null),
    }).finally(done);
    // Keyed on the outcome's identity only (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, last?.type]);

  return null;
}
