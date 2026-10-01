import { Fragment, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { nameSeparator, launchVerb } from "../../../lib/subagentRuns.js";
import { SubagentGlyph } from "./SubagentGlyph.jsx";
import { openSubagents } from "./openSubagents.js";

// One launch batch in the transcript: "◆ ✣ ✺  Git özeti, Dosya özeti and Unity
// sürümü started working". Hovering a name lights it and its glyph together;
// clicking either opens that subagent in the side panel.
export function SubagentLine({ runs, workerId }) {
  const ui = useUi();
  const [hot, setHot] = useState(null);
  const handlers = (id) => ({
    onClick: () => openSubagents(ui, workerId, id),
    onMouseEnter: () => setHot(id),
    onMouseLeave: () => setHot(null),
  });

  return (
    <div className="sa-line">
      <span className="sa-line__glyphs">
        {runs.map((r) => (
          // The name button is the accessible target; the glyph mirrors it for the mouse.
          <button key={r.toolUseId} type="button" tabIndex={-1} aria-hidden="true"
            className={"sa-line__glyph" + (hot === r.toolUseId ? " is-hot" : "")} {...handlers(r.toolUseId)}>
            <SubagentGlyph identity={r.identity} status={r.status} />
          </button>
        ))}
      </span>
      <span className="sa-line__text">
        {runs.map((r, i) => (
          <Fragment key={r.toolUseId}>
            <button type="button" className={"sa-name" + (hot === r.toolUseId ? " is-hot" : "")} {...handlers(r.toolUseId)}>
              {r.description}
            </button>
            {nameSeparator(i, runs.length)}
          </Fragment>
        ))}
        {launchVerb(runs)}
      </span>
    </div>
  );
}
