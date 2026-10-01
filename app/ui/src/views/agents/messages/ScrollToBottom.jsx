import { useEffect, useState } from "react";
import { GlassLayers } from "../../../components/glass/GlassLayers.jsx";

// How long the drop stays mounted after it's hidden, so it can shrink away
// (transcript.css).
const LEAVE_MS = 420;

// The frosted liquid-glass drop over the transcript's tail: grows on hover,
// presses in on press.
export function ScrollToBottom({ show, onClick }) {
  const [mounted, setMounted] = useState(show);

  useEffect(() => {
    if (show) {
      setMounted(true);
      return undefined;
    }
    const t = setTimeout(() => setMounted(false), LEAVE_MS);
    return () => clearTimeout(t);
  }, [show]);

  if (!show && !mounted) return null;
  return (
    <button
      className={"scroll-to-bottom" + (show ? "" : " is-leaving")}
      onClick={onClick}
      tabIndex={show ? undefined : -1}
      aria-label="Scroll to bottom"
    >
      <GlassLayers />
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}
