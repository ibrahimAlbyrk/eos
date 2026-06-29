import { createContext, useContext } from "react";

// Publishes the leaf id of the pane a subtree renders inside. A panel opened
// from a transcript click resolves to its OWN pane via this context; shared
// chrome (composer/header) renders OUTSIDE any provider → value is null →
// callers fall back to the focused pane. See useUi for the resolution.
export const PaneScopeContext = createContext(null);

export const useOriginPane = () => useContext(PaneScopeContext);
