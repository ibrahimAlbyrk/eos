// Root component — owns layout state (selection, panel collapse, modals) and
// wires the data layer (window.live) to the rendered tree via useLive().
//
// Every leaf component is React.memo'd in its own file. App.jsx itself only
// re-renders when window.live emits or the elapsed-tick fires, but the cheap
// equality checks in memoized children prevent that from cascading.

import { useState, useMemo, useCallback, useEffect } from "react";
import { CONFIG } from "./config.js";
import { useLive, useTick } from "./hooks/useLive.js";
import { LeftPanelHandle, RightPanelHandle } from "./components/primitives.jsx";
import { Topbar } from "./components/Topbar.jsx";
import { AgentsPanel, SpawnModal, AgentContextMenu, QuickPromptModal } from "./components/AgentsPanel.jsx";
import { Center } from "./components/Center.jsx";
import { Details } from "./components/Details.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { SearchModal } from "./components/SearchModal.jsx";

export default function App() {
  const { agents, events, pending, online, session } = useLive();
  useTick(CONFIG.elapsedTickMs);

  const [selectedId, setSelectedId] = useState("orchestrator");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null);          // { agentId, x, y }
  const [quickPrompt, setQuickPrompt] = useState(null);  // agentId

  // Global keyboard shortcuts — Cmd/Ctrl+Shift+F opens cross-event search.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = useMemo(
    () => agents.find(a => a.id === selectedId) || null,
    [agents, selectedId],
  );

  const visibleEvents = useMemo(() => {
    if (!selectedId) return events;
    return events.filter(e => e.agent === selectedId || e.agent === "user");
  }, [events, selectedId]);

  const onSend = useCallback(async (text) => {
    await window.live.sendMessage(text, selectedId);
  }, [selectedId]);

  const onApprove = useCallback((pid, updatedInput) => window.live.approvePending(pid, updatedInput), []);
  const onDeny = useCallback((pid) => window.live.denyPending(pid), []);
  const onSpawnOrchestrator = useCallback(async () => {
    await window.live.spawnOrchestrator();
    setSelectedId("orchestrator");
  }, []);

  const onAgentContextMenu = useCallback((agentId, x, y) => setCtxMenu({ agentId, x, y }), []);
  const onKillAgent = useCallback((agentId) => window.live.killAgent(agentId), []);
  const onQuickPromptSend = useCallback((text, agentId) => window.live.sendMessage(text, agentId), []);
  const onSpawnClick = useCallback(() => setSpawnOpen(true), []);
  const onSpawnClose = useCallback(() => setSpawnOpen(false), []);
  const onSpawnedSelect = useCallback((id) => setSelectedId(id), []);
  const onCtxClose = useCallback(() => setCtxMenu(null), []);
  const onQuickPromptOpen = useCallback((id) => setQuickPrompt(id), []);
  const onQuickPromptClose = useCallback(() => setQuickPrompt(null), []);
  const onLeftCollapse = useCallback(() => setLeftCollapsed(true), []);
  const onLeftExpand = useCallback(() => setLeftCollapsed(false), []);
  const onRightCollapse = useCallback(() => setRightCollapsed(true), []);
  const onRightExpand = useCallback(() => setRightCollapsed(false), []);

  const bodyCls = useMemo(() => {
    if (leftCollapsed && rightCollapsed) return "vb-body vb-body--both-collapsed";
    if (leftCollapsed) return "vb-body vb-body--left-collapsed";
    if (rightCollapsed) return "vb-body vb-body--right-collapsed";
    return "vb-body";
  }, [leftCollapsed, rightCollapsed]);

  const quickPromptAgent = useMemo(
    () => agents.find(a => a.id === quickPrompt) || null,
    [agents, quickPrompt],
  );

  return (
    <div className="vb-app">
      <Topbar agents={agents} session={session} online={online} sessionName="claude-manager session" />
      <div className={bodyCls}>
        {leftCollapsed
          ? <LeftPanelHandle onExpand={onLeftExpand} />
          : <ErrorBoundary label="Agents panel">
              <AgentsPanel
                agents={agents}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onCollapse={onLeftCollapse}
                online={online}
                onSpawnClick={onSpawnClick}
                onSpawnOrchestrator={onSpawnOrchestrator}
                session={session}
                onContextMenu={onAgentContextMenu}
              />
            </ErrorBoundary>
        }
        <ErrorBoundary label="Center">
          <Center
            events={visibleEvents}
            agents={agents}
            selected={selected}
            pending={pending}
            onApprove={onApprove}
            onDeny={onDeny}
            onSend={onSend}
          />
        </ErrorBoundary>
        {rightCollapsed
          ? <RightPanelHandle onExpand={onRightExpand} />
          : <ErrorBoundary label="Details panel">
              <Details agent={selected} agents={agents} onSelect={setSelectedId} onCollapse={onRightCollapse} />
            </ErrorBoundary>
        }
      </div>
      <SpawnModal open={spawnOpen} onClose={onSpawnClose} onSpawned={onSpawnedSelect} />
      <AgentContextMenu
        menu={ctxMenu}
        onClose={onCtxClose}
        onQuickPrompt={onQuickPromptOpen}
        onKill={onKillAgent}
      />
      <QuickPromptModal
        open={!!quickPrompt}
        agent={quickPromptAgent}
        onClose={onQuickPromptClose}
        onSend={onQuickPromptSend}
      />
      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        events={events}
        agents={agents}
        onPick={(e) => { setSelectedId(e.agent); }}
      />
    </div>
  );
}
