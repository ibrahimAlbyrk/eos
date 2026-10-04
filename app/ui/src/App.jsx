import { useEffect, useState } from "react";
import { useUi, UiProvider, useAttentionSync } from "./state/ui.jsx";
import { useLive } from "./hooks/useLive.js";
import { useStorePrune } from "./hooks/useStorePrune.js";
import { useViewSwitchHotkeys } from "./hooks/useViewSwitchHotkeys.js";
import { useSidebarToggleHotkey } from "./hooks/useSidebarToggleHotkey.js";
import { usePopoverOutsideClick } from "./hooks/usePopoverOutsideClick.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { CommandPalette } from "./components/search/CommandPalette.jsx";
import { SettingsModal } from "./components/settings/SettingsModal.jsx";
import { ProjectModalHost } from "./components/project/ProjectModal.jsx";
import { MonitorWidget } from "./components/monitor/MonitorWidget.jsx";
import { NativeToggleZone } from "./components/layout/NativeToggleZone.jsx";
import { SideHandle } from "./components/layout/SideHandle.jsx";
import { SidebarPopup } from "./components/layout/SidebarPopup.jsx";
import { getViewComponent, getViewSidebar, keepsMounted } from "./views/registry.js";
import { useSettings } from "./state/settings.jsx";
import { useAccounts, ensureAccountsLoaded, noAccountConnected } from "./state/accountsStore.js";
import { WelcomeScreen } from "./components/accounts/WelcomeScreen.jsx";
import { useOpenMemory } from "./hooks/useOpenMemory.js";
import { ProfileInterview } from "./components/profile/ProfileInterview.jsx";
import { useProfile, ensureProfileLoaded } from "./state/profileStore.js";
import { useInterviewOpen, openProfileInterview, closeProfileInterview } from "./state/interviewStore.js";
import { shouldOfferInterview } from "./lib/profileInterview.js";
import { ConnectSheetHost } from "./components/accounts/ConnectSheet.jsx";
import { ConnectMachineSheet } from "./components/machines/ConnectMachineSheet.jsx";
import { LinkBanner } from "./components/machines/LinkBanner.jsx";
import { RemotePicker } from "./components/machines/RemotePicker.jsx";

function Shell() {
  const ui = useUi();
  const live = useLive();

  // Attention bookkeeping runs here, not in a view, so the sidebar dot
  // state stays correct while other tabs are active.
  useAttentionSync(live.workers, ui.selectedId);

  // Drop per-worker caches for workers that left the live list (auto-shutdown,
  // cascade death, daemon-restart disappearance) — the explicit-delete purge
  // can't catch those.
  useStorePrune(live.workers);

  // Cmd+Ctrl+1/2 → Agents / Code.
  useViewSwitchHotkeys();
  // Cmd+B → collapse / expand the sidebar.
  useSidebarToggleHotkey();
  usePopoverOutsideClick(ui);

  // First-run welcome: decided ONCE, when both the stored skip flag and the
  // accounts have loaded — shown only when nothing is connected at all and the
  // user never skipped it. It then stays up through the sign-ins it starts (an
  // account turning connected must not yank it away) until Continue / Skip.
  // The profile interview follows it (or opens alone for an existing user) while
  // the profile was never set up and the interview never skipped.
  const { settings, settingsLoaded, setSetting, openSettings } = useSettings();
  const { accounts } = useAccounts();
  const { profile, loaded: profileLoaded } = useProfile();
  const interviewOpen = useInterviewOpen();
  const [welcome, setWelcome] = useState("pending"); // pending → open | closed
  useEffect(() => { ensureAccountsLoaded(); ensureProfileLoaded(); }, []);
  useEffect(() => {
    if (welcome !== "pending" || !settingsLoaded || !accounts || !profileLoaded) return;
    const showWelcome = !settings["onboarding.dismissed"] && noAccountConnected(accounts);
    setWelcome(showWelcome ? "open" : "closed");
    if (!showWelcome && shouldOfferInterview(profile, settings)) openProfileInterview();
  }, [welcome, settingsLoaded, accounts, profileLoaded, profile, settings]);

  // Panel-level attention for the collapsed-sidebar expand button pip.
  const hasAttention = ui.anyNeedsAttention(live.workers);

  // Native app notification tap → jump to the Code tab and select the worker
  // (focuses its pane when a split already shows it, instead of duplicating it).
  useEffect(() => {
    window.__nativeNavigate = (id) => { ui.setActiveView("agents"); ui.selectAgent(id); };
    return () => { delete window.__nativeNavigate; };
  }, [ui.setActiveView, ui.selectAgent]);

  // A notification about the user rather than a worker (e.g. memory suggestions).
  const openMemory = useOpenMemory();
  useEffect(() => {
    window.__nativeOpenRoute = (route) => { if (route === "memory") openMemory(); };
    return () => { delete window.__nativeOpenRoute; };
  }, [openMemory]);

  // Recall (interrupt before the agent responded) is consumed directly by the
  // pane's Composer that owns recall.workerId (recallStore) — no selectedId-keyed
  // derivation here, so nothing re-injects on re-render, reselect, or reconnect.

  const ActiveView = getViewComponent(ui.activeViewId);

  // Keep-mounted views opened so far; they stay rendered (hidden) after the user
  // switches away. Adjusting state during render is React's derive-from-props idiom.
  const [keptIds, setKeptIds] = useState([]);
  if (keepsMounted(ui.activeViewId) && !keptIds.includes(ui.activeViewId)) {
    setKeptIds([...keptIds, ui.activeViewId]);
  }

  // Shell chrome (collapsed-rail handle + native toggle + hover flyout) lives
  // here, not inside the per-view AppLayout, so it stays mounted across view
  // switches and the flyout no longer remounts/flickers. Only the flyout's
  // contents swap, via the active view's registered sidebar.
  const Sidebar = getViewSidebar(ui.activeViewId);
  const popup = <SidebarPopup><Sidebar live={live} variant="popup" /></SidebarPopup>;

  return (
    <>
      {!keepsMounted(ui.activeViewId) && <ActiveView live={live} />}
      {keptIds.map((id) => {
        const View = getViewComponent(id);
        return <View key={id} live={live} active={id === ui.activeViewId} />;
      })}
      <NativeToggleZone popup={popup} hasAttention={hasAttention} />
      <SideHandle popup={popup} hasAttention={hasAttention} />
      <CommandPalette live={live} />
      <MonitorWidget live={live} />
      <SettingsModal />
      <ProjectModalHost />
      <ConnectSheetHost />
      <ConnectMachineSheet />
      <LinkBanner />
      <RemotePicker />
      {welcome === "open" && (
        <WelcomeScreen
          onContinue={() => { setWelcome("closed"); if (shouldOfferInterview(profile, settings)) openProfileInterview(); }}
          onSkip={() => { setSetting("onboarding.dismissed", true); setWelcome("closed"); }}
          onUseKeys={() => { setWelcome("closed"); openSettings("accounts"); }}
        />
      )}
      {interviewOpen && profile && (
        <ProfileInterview
          profile={profile}
          onClose={closeProfileInterview}
          onSkip={() => { setSetting("onboarding.profileDismissed", true); closeProfileInterview(); }}
          onOpenProfile={() => { closeProfileInterview(); openSettings("profile"); }}
        />
      )}
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <UiProvider>
        <Shell />
      </UiProvider>
    </ErrorBoundary>
  );
}
