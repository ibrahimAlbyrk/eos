import { createRoot } from "react-dom/client";
import { createReconnectingStream } from "../../../api/sse.js";
import { applyEosEvent, resyncEos } from "../../../state/eos/live.js";
import { QuickPanel } from "./QuickPanel.jsx";

// The quick panel's document (`index.html?surface=quick`): only the panel,
// with Eos's live topics so its run lines move. It never starts the app.
export function startQuickPanel(rootEl) {
  document.documentElement.classList.add("eos-quick-doc");
  createReconnectingStream({
    onChange: (e) => {
      try {
        const data = JSON.parse(e.data);
        applyEosEvent(data.reason, data.payload);
      } catch { /* a frame that is not JSON is not Eos's */ }
    },
    onResync: resyncEos,
  });
  createRoot(rootEl).render(<QuickPanel />);
}
