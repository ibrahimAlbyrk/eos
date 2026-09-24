import { createContext, useContext } from "react";

// What a side panel's tabs work on when it isn't about an agent. The Code view
// provides { key, cwd }: `cwd` is the focused pane's folder and `key` groups the
// panel's terminals. Absent (null) → panels derive both from the selected agent.
export const PanelHostContext = createContext(null);

export const usePanelHost = () => useContext(PanelHostContext);
