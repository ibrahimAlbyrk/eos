import { useEffect, useState } from "react";

// Matches the .collapse grid-rows transition in transcript.css.
const COLLAPSE_MS = 620;

// Animated disclosure body — the thinking block's expand/collapse motion.
// Children mount on open and unmount only once the collapse has played out, so
// closed content costs nothing. Content that is already open on first render
// (default-expanded, remount on scroll) appears without the enter motion.
export function Collapse({ open, children }) {
  const [mounted, setMounted] = useState(open);
  const [animateEnter, setAnimateEnter] = useState(false);
  if (open && !mounted) {
    setMounted(true);
    setAnimateEnter(true);
  }
  useEffect(() => {
    if (open || !mounted) return;
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  if (!mounted) return null;
  const cls = "collapse" + (open ? "" : " is-collapsed") + (animateEnter ? " is-entering" : "");
  return (
    <div className={cls}>
      <div className="collapse-in"><div className="collapse-body">{children}</div></div>
    </div>
  );
}
