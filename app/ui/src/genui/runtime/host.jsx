// Where a view's actions land: the conversation that presented it (send), that
// pane's composer (prefill), the side panel (open: browser or file), the
// clipboard (copy). The transcript and the side panel provide the conversation;
// the rest comes from the pane the view renders in.

import { createContext, useContext, useMemo } from "react";
import { useUi } from "../../state/ui.jsx";
import { useOriginPane } from "../../state/paneScope.js";
import { queueUrl } from "../../state/browserPanelStore.js";
import { pushTextHandoff } from "../../state/browserComposerHandoff.js";
import { useBrowserSessionKey } from "../../views/browser/useBrowserSessionKey.js";
import { isRemoteView } from "../../lib/host.js";
import { notify } from "../../lib/notify.js";

// { workerId, cwd, project, send(text, opts) → Promise<{ok}>, superseded: Map<viewId, {title}>, fixedBelow: Set<callId> }
export const GenuiHostContext = createContext(null);

export const useGenuiConversation = () => useContext(GenuiHostContext);

// "~/x" under the agent's home ("/Users/<name>" from its folder), a relative
// path under the agent's folder; an absolute path as given.
export function resolvePath(path, cwd) {
  if (path.startsWith("~/")) {
    const home = /^\/Users\/[^/]+/.exec(cwd ?? "")?.[0];
    return home ? `${home}${path.slice(1)}` : path;
  }
  if (path.startsWith("/") || !cwd) return path;
  return `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

export function useActionHost() {
  const conv = useGenuiConversation();
  const ui = useUi();
  const paneId = useOriginPane() ?? ui.paneId;
  const sessionKey = useBrowserSessionKey();
  const { openPanel, openFile } = ui;
  return useMemo(() => ({
    send: (text, opts) => (conv?.send ? conv.send(text, opts) : Promise.resolve({ ok: false, status: 0, body: { error: "no conversation" } })),
    prefill: (text) => pushTextHandoff(paneId, text),
    openUrl: (url) => {
      // A view of another computer has no browser panel of this Mac's.
      if (isRemoteView()) { window.open(url, "_blank"); return; }
      queueUrl(sessionKey, url);
      openPanel("browser");
    },
    openExternal: (href) => { window.open(href, "_blank"); },
    openFile: (path, line) => openFile(resolvePath(path, conv?.cwd), line ? { line: Number(line) } : undefined),
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        notify.info("Copied");
      } catch (e) {
        notify.error(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }), [conv, paneId, sessionKey, openPanel, openFile]);
}
