import { useNow } from "../hooks/useNow.js";

// Renders `children()` again every second — for a piece of text derived from
// the time inside a component that should not re-render on that beat.
export function Ticking({ children }) {
  useNow();
  return children();
}
