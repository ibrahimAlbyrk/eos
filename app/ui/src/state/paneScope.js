import { createContext, useContext } from "react";

// Publishes the leaf id of the pane a subtree renders inside. A panel opened
// from a transcript click resolves to its OWN pane via this context; shared
// chrome (composer/header) renders OUTSIDE any provider → value is null →
// callers fall back to the focused pane. See useUi for the resolution.
export const PaneScopeContext = createContext(null);

export const useOriginPane = () => useContext(PaneScopeContext);

// True inside a side panel's body: a file opened from there lands in the panel's
// dock; opened from anywhere else (transcript, header) it gets its own tab.
export const SidePanelScopeContext = createContext(false);

// False inside a side-panel subtree kept mounted off screen (another tab is
// shown, or the panel is closed) so it keeps its state — keyboard handlers and
// terminals stand down there. True everywhere else.
export const SidePanelVisibleContext = createContext(true);

export const useSidePanelVisible = () => useContext(SidePanelVisibleContext);
