import { useEffect } from "react";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { HomeSidebar } from "./sidebar/HomeSidebar.jsx";
import { HomeComposer } from "./HomeComposer.jsx";
import { Messages } from "../code/messages/Messages.jsx";
import { useUi } from "../../state/ui.jsx";
import { useHome, refreshHome } from "../../state/homeStore.js";

// Home — a Claude-web-style single-agent chat: a conversation list on the left,
// and in the center one reading column (slim title bar, transcript, floating
// composer). The transcript reuses the Code view's <Messages> over the same
// per-agent event stream; Home re-columns it in CSS (.home-chat .messages) and
// owns only the title bar and the composer.
export function HomeView({ live }) {
  const ui = useUi();
  const { selectedId, conversations } = useHome();

  // Load the list on mount and refresh on each SSE change ping so names (auto-
  // named from the first message) and states stay current.
  useEffect(() => { refreshHome(); }, []);
  useEffect(() => { refreshHome(); }, [live?.eventSignal?.tick]);

  // The composer's model/effort/attach pickers ride the shared ui.openPop
  // plumbing, whose outside-click dismissal is per view (Escape is global —
  // see selection.jsx). Closing on unmount keeps a Home popover from surfacing
  // in the Code composer after a tab switch (the open state is pane-keyed).
  useEffect(() => {
    if (!ui.openPopover) return;
    const handler = (e) => {
      const inside = e.target.closest(`[data-popover="${ui.openPopover}"]`)
        || e.target.closest(`[data-popover-trigger="${ui.openPopover}"]`);
      if (!inside) ui.closeAllPops();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ui.openPopover, ui]);
  const closeAllPops = ui.closeAllPops;
  useEffect(() => () => closeAllPops(), [closeAllPops]);

  // live.workers carries the conversation's runtime row (state, model, effort);
  // the /home list is the fallback while a fresh spawn propagates.
  const worker = live.workers.find((w) => w.id === selectedId) ?? null;
  const listed = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <AppLayout
      sidebar={(variant) => <HomeSidebar live={live} variant={variant} />}
      main={
        <div className="home">
          {/* .pane-head carries the window-drag strip, the native traffic-light
              inset and the scroll scrim — Home only restyles its contents. */}
          <div className="pane-head pane-head--topleft home-head">
            <span className="pane-head-inset" aria-hidden="true" />
            <div className="home-head__title">
              {selectedId ? (worker?.name || listed?.name || "Untitled") : "New chat"}
            </div>
          </div>

          {selectedId ? (
            <div className="home-chat" key={selectedId}>
              <div className="home-chat__transcript">
                <Messages live={live} agentId={selectedId} />
              </div>
              <HomeComposer conversationId={selectedId} worker={worker} live={live} />
            </div>
          ) : (
            <div className="home-empty">
              <div className="home-empty__inner">
                <h1 className="home-empty__hero">How can I help you today?</h1>
                <HomeComposer conversationId={null} worker={null} live={live} />
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}
