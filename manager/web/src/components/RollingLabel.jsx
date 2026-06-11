import { useEffect, useRef, useState } from "react";

// Directional blur-roll label for values on an ordered scale. When `text`
// changes, the old label slides out toward the move direction (derived from
// the `index` delta) while the new one rolls in from the opposite edge, both
// through a blur+fade. index up → old exits up, new enters from below.
// The roll state is derived during render (not in an effect) so the incoming
// span carries its animation class on its very first paint — an effect-based
// version flashes the new text unanimated for one frame.
export function RollingLabel({ text, index = 0, className = "" }) {
  const prev = useRef({ text, index });
  const [roll, setRoll] = useState(null);

  if (text !== prev.current.text) {
    setRoll({ text: prev.current.text, dir: index >= prev.current.index ? "up" : "down" });
    prev.current = { text, index };
  }

  useEffect(() => {
    if (!roll) return;
    const t = setTimeout(() => setRoll(null), 340);
    return () => clearTimeout(t);
  }, [roll]);

  return (
    <span className={`rolling-label ${className}`}>
      {roll && <span key={`out-${roll.text}`} className={`rl-out rl-${roll.dir}`}>{roll.text}</span>}
      <span key={text} className={roll ? `rl-in rl-${roll.dir}` : undefined}>{text}</span>
    </span>
  );
}
