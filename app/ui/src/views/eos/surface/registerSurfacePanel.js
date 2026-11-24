// The side-panel tab of a routine's App (`surface-app:<surfaceId>`, 08 §4.11),
// in Eos's side panel only. Importing this module registers it.

import { createElement } from "react";
import { registerPanel } from "../../../lib/panelRegistry.js";
import { surfaceAppIdOf } from "../../../lib/panelTabs.js";
import { usePages } from "../../../state/eos/pageStore.js";
import { TAB_ICONS } from "../../agents/panes/panelTabMeta.jsx";
import { AppSurface } from "./AppSurface.jsx";

function SurfaceAppPanel({ tabId }) {
  return createElement(AppSurface, { surfaceId: surfaceAppIdOf(tabId), inPanel: true });
}

export function useSurfaceAppTitle(id) {
  const { pages } = usePages();
  const title = pages[surfaceAppIdOf(id)]?.surface?.title;
  return title ? `App · ${title}` : null;
}

registerPanel({ type: "surface-app", label: "App", icon: TAB_ICONS.view, surface: ["eos"], Component: SurfaceAppPanel, useTitle: useSurfaceAppTitle });
