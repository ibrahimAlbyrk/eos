import { useRef } from "react";
import { ActivityStar } from "./ActivityStar.jsx";

// Inline activity indicator anchored under the latest message.
//   • busy=true  → turning Eos star + "working" + live elapsed
//   • busy=false → small grey star, no text (silent anchor under the reply).
//     A line that saw the agent busy plays the settle once (is-done) so the
//     spin eases out instead of snapping grey; one mounted idle stays still.
export function ProcessingLine({ busy, elapsed }) {
  const sawBusy = useRef(false);
  if (busy) sawBusy.current = true;
  const state = busy ? " is-busy" : sawBusy.current ? " is-done" : "";
  return (
    <div className={"activity-line" + state}>
      <ActivityStar />
      {busy && (
        <span>
          working
          {elapsed && <> · <span className="mono">{elapsed}</span></>}
        </span>
      )}
    </div>
  );
}
