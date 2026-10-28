import { useNavigation } from "../state/navigation.jsx";
import { useKeybinding } from "../keymap/useKeymap.js";
import { visibleTabs } from "../views/tabs.js";
import { modifiers } from "../lib/platform.js";

// Cmd+Ctrl+1..N → switch to the Nth workspace view (TABS order: Agents, Code).
// Reads e.code so the digit resolves regardless of keyboard layout. Stops the
// event so it never also reaches a focused xterm.
export function useViewSwitchHotkeys() {
  const { setActiveView } = useNavigation();
  useKeybinding({
    terminalSafe: true,
    match: (e) => {
      const m = modifiers(e);
      return m.mod && m.ctrl && !m.alt && !m.shift && /^Digit[1-9]$/.test(e.code);
    },
    run: (ctx, e) => {
      const tab = visibleTabs()[Number(e.code.slice(5)) - 1];
      if (!tab) return;
      e.preventDefault();
      e.stopPropagation();
      setActiveView(tab.id);
    },
  }, [setActiveView]);
}
