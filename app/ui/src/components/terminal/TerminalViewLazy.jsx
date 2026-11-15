import { useEffect, useState } from "react";
// Here, not in TerminalView.jsx, so xterm's styles stay in the main stylesheet, in
// the same place, rather than arriving with the split chunk.
import "@xterm/xterm/css/xterm.css";
import { preloadable } from "../../lib/preloadable.js";

// xterm.js and its WebGL renderer are a quarter of the dashboard's script, and only a
// terminal needs them: TerminalView loads as its own chunk, fetched after the first
// paint (main.jsx). Loaded, it renders directly. A terminal drawn before that (one
// restored at start-up) shows the same empty host TerminalView itself shows until
// xterm opens in it (it waits for the layout to settle), then the real one. A failed
// load keeps the empty host; the next mount tries again.
export const terminalViewModule = preloadable(() => import("./TerminalView.jsx"));

export function TerminalView(props) {
  // Chosen once loaded: switching component types would remount the terminal.
  const [Loaded, setLoaded] = useState(() => terminalViewModule.value?.TerminalView ?? null);
  useEffect(() => {
    if (Loaded) return;
    let live = true;
    terminalViewModule.load().then((m) => { if (live) setLoaded(() => m.TerminalView); }, () => {});
    return () => { live = false; };
  }, [Loaded]);
  if (Loaded) return <Loaded {...props} />;
  const visible = props.visible === undefined ? props.active : props.visible;
  return <div className="pty-view" style={{ display: visible ? "block" : "none" }} />;
}
