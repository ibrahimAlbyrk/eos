import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { useGlobalKeymap } from "../../keymap/useKeymap.js";
import { EosMain } from "./EosMain.jsx";
import { EosSidebar } from "./sidebar/EosSidebar.jsx";

// Eos mode. The keymap's one listener lives in the view that is shown; without
// it here, no app shortcut (⌘⌃2 back to Agents among them) would reach Eos.
export function EosView({ live }) {
  useGlobalKeymap();
  return <AppLayout sidebar={(variant) => <EosSidebar live={live} variant={variant} />} main={<EosMain />} />;
}
