import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { fmtElapsedShort } from "../../../lib/format.js";
import { DisclosureRow } from "./DisclosureRow.jsx";
import { Collapse } from "./Collapse.jsx";

// Covers the settle in transcript.css: steps collapse (80 + 760ms), the label
// absorbs (1260ms), the rule draws (420 + 720ms).
const SETTLE_MS = 1300;

const canAnimate = () => !document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches;

// A finished turn's work behind one "Worked for …" row (lib/turnFold.js); it
// opens below the rule to the steps exactly as they streamed.
// `settle`: this view watched the work stream in — it mounts open, laid out as
// the steps were, then glides them up into the row once.
export function TurnFold({ fold, settle, renderStep }) {
  const ui = useUi();
  const [stage, setStage] = useState(() => (settle && canAnimate() ? "live" : "rest"));
  useEffect(() => {
    if (stage === "live") {
      // Two frames: the open layout must paint before the collapse transitions away from it.
      let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => setStage("settling")); });
      return () => cancelAnimationFrame(raf);
    }
    if (stage === "settling") {
      const t = setTimeout(() => setStage("rest"), SETTLE_MS);
      return () => clearTimeout(t);
    }
  }, [stage]);

  const openKey = "f:" + fold.key;
  const open = ui.expandedTools.has(openKey);
  const steps = <div className="turn-fold-steps">{fold.work.map((b) => renderStep(b))}</div>;
  return (
    <div className={"turn-fold is-" + stage}>
      <div className="turn-fold-head">
        <div>
          <DisclosureRow expanded={open} onToggle={() => ui.toggleToolExpanded(openKey)} className="tool-group-header turn-fold-row">
            <span>{workedLabel(fold.durationMs)}</span>
          </DisclosureRow>
          <div className="turn-fold-rule" />
        </div>
      </div>
      {stage === "rest"
        ? <Collapse open={open}>{steps}</Collapse>
        : <div className="turn-fold-flat"><div className="turn-fold-flat-in">{steps}</div></div>}
    </div>
  );
}

function workedLabel(ms) {
  return ms == null ? "Worked" : `Worked for ${fmtElapsedShort(Math.max(ms, 1000))}`;
}
