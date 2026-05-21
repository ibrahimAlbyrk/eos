import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./primitives.jsx";

const STORAGE_KEY = "vb.theme";

// Resolves the theme on first paint. Order: explicit localStorage choice →
// system preference. Synchronous so the initial render matches the value
// applied by main.jsx (no flash-of-wrong-theme on reload).
function resolveInitial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function prefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch { return false; }
}

export const ThemeToggle = memo(function ThemeToggle() {
  const [theme, setTheme] = useState(resolveInitial);
  const btnRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
  }, [theme]);

  const onToggle = useCallback(() => {
    const next = theme === "light" ? "dark" : "light";

    // Compute the ripple origin (button center) + the radius needed to reach
    // the farthest viewport corner. Plumb both into CSS vars so the keyframe
    // can read them without hard-coding viewport assumptions.
    const rect = btnRef.current?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    const dx = Math.max(x, window.innerWidth - x);
    const dy = Math.max(y, window.innerHeight - y);
    const radius = Math.hypot(dx, dy);
    const root = document.documentElement;
    root.style.setProperty("--vb-theme-ripple-x", `${x}px`);
    root.style.setProperty("--vb-theme-ripple-y", `${y}px`);
    root.style.setProperty("--vb-theme-ripple-r", `${radius}px`);

    // No animation if the browser lacks View Transitions or the user asked
    // for reduced motion — fall through to a plain state update.
    const supportsVT = typeof document.startViewTransition === "function";
    if (!supportsVT || prefersReducedMotion()) {
      setTheme(next);
      return;
    }

    // Mark the run direction so CSS can pick which clip-path animates.
    root.setAttribute("data-theme-transition", next);
    const transition = document.startViewTransition(() => {
      setTheme(next);
    });
    transition.finished
      .catch(() => {}) // skip transitions are not failures
      .finally(() => { root.removeAttribute("data-theme-transition"); });
  }, [theme]);

  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      ref={btnRef}
      className="vb-iconbtn vb-theme-toggle"
      onClick={onToggle}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      aria-pressed={theme === "light"}
    >
      {/* In dark mode we show the sun (action: go to light). In light mode
        * we show the moon (action: go to dark). Matches the platform-native
        * convention used by VS Code, GitHub, etc. */}
      <Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
    </button>
  );
});
