import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { useGlobalKeymap, useKeybinding } from "../../keymap/useKeymap.js";
import { combo, isMod } from "../../keymap/index.js";
import { EosMain } from "./EosMain.jsx";
import { AboutYouTab } from "./memory/AboutYou.jsx";
import { AboutYouSlot } from "./memory/aboutYouSlot.js";
import { RunSheet } from "./runform/RunSheet.jsx";
import { EosSidebar } from "./sidebar/EosSidebar.jsx";
import { useField } from "./field/fieldStore.js";
import { goBack, goForward, openLocation } from "./nav/eosNav.js";

// ⌘N opens a new routine. ⌘[ / ⌘] walk Eos's own history. Matched by the key's place, as ⌘⌃1…9 are,
// so every keyboard layout has them where a US one does.
const historyKey = (code) => (e) => isMod(e) && e.code === code;

// Eos mode, with the run sheet's host. It is mounted only while shown, so
// its keys are bound only then. The keymap's one listener lives in the view
// that is shown; without it here, no app shortcut (⌘⌃2 back to Agents among
// them) would reach Eos.
export function EosView({ live }) {
  useGlobalKeymap();
  useKeybinding({ match: historyKey("BracketLeft"), run: (ctx, e) => { e.preventDefault(); goBack(); } }, []);
  useKeybinding({ match: historyKey("BracketRight"), run: (ctx, e) => { e.preventDefault(); goForward(); } }, []);
  useKeybinding({ match: combo("mod+n"), run: (ctx, e) => { e.preventDefault(); openLocation("eos:/routines/new"); } }, []);
  const { on: fieldOn } = useField();
  return <AppLayout gridClass={fieldOn ? "eos-mode eos-mode--field" : "eos-mode"} sidebar={(variant) => <EosSidebar live={live} variant={variant} />} main={<AboutYouSlot.Provider value={AboutYouTab}><EosMain /><RunSheet /></AboutYouSlot.Provider>} />;
}
