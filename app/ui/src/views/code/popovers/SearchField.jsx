import { useEffect, useRef } from "react";
import { SearchIcon } from "../../../lib/gitIconKit.jsx";

// Shared search input for chip dropdowns (branch panel, folder panel).
// Self-focuses on mount via rAF so typing works immediately — deferred past
// the trigger button's focus settling (a plain autoFocus would bounce back).
export function SearchField({ value, onChange, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    const raf = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="cb-dd-search">
      <SearchIcon size={11} />
      <input
        ref={ref}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
