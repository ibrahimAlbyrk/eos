import { useRef, useState } from "react";
import { CommandInfo } from "../center/CommandInfo.jsx";

// Slash-command pill inside a sent bubble. The info card is a CSS hover
// reveal (spans, not divs — it lives inside inline message text). Hidden via
// visibility, so it has layout: on enter we measure it against the scroll
// container's top edge and flip below the pill when above would clip.
export function SlashPill({ text, cmd }) {
  const cardRef = useRef(null);
  const [below, setBelow] = useState(false);

  const onEnter = (e) => {
    const card = cardRef.current;
    if (!card) return;
    const pillTop = e.currentTarget.getBoundingClientRect().top;
    const clipTop = e.currentTarget.closest(".messages")?.getBoundingClientRect().top ?? 0;
    setBelow(pillTop - card.offsetHeight - 8 < clipTop);
  };

  return (
    <span className="cmd-pill-wrap" onMouseEnter={onEnter}>
      <span className="cmd-pill">{text}</span>
      {cmd?.description && (
        <span ref={cardRef} className={"slash-hovercard glass-pop" + (below ? " below" : "")}>
          <span className="slash-info-name">/{cmd.name}</span>
          <span className="slash-info-body"><CommandInfo cmd={cmd} /></span>
        </span>
      )}
    </span>
  );
}
