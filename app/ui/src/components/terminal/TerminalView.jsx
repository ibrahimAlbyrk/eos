import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/client.js";
import { onPtyData, onPtyExit } from "../../state/ptyBus.js";
import { markExited } from "../../state/ptyPanelStore.js";

// ONE xterm.js instance per PTY session. Stays MOUNTED while inactive (parent
// hides it with display:none) so scrollback survives tab switches client-side.
//
// Sessions always open clean (no reattach/buffer replay), so incoming pty:data is
// written straight through in SSE order — no seq dedup. Wiring: xterm.onData →
// POST /pty/:id/input (coalescing send queue); pty:data → term.write.
//
// Open path is deferred to avoid open-time jank: xterm.open()+the first fit run
// in a rAF (out of the React commit frame that starts the island's width/opacity
// transition), and every fit is debounced so the ResizeObserver firing per-frame
// during the transition settles into ONE fit + one resize POST, not a reflow storm.
export function TerminalView({ sessionId, active }) {
  const hostRef = useRef(null);
  const ctl = useRef(null); // { scheduleFit, focus } — for the active-tab effect
  const lastSize = useRef({ cols: 0, rows: 0 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ebebeb";
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
        "monospace",
      fontSize: 12,
      theme: { background: "#1a1a1a", foreground: "#ebebeb", cursor: accent },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    let opened = false;
    let fitTimer = null;
    const settleFit = () => {
      if (!opened || !host.clientWidth || !host.clientHeight) return;
      try { fit.fit(); } catch { return; }
      const { cols, rows } = term;
      if (cols === lastSize.current.cols && rows === lastSize.current.rows) return;
      lastSize.current = { cols, rows };
      api.resizePty(sessionId, cols, rows).catch(() => {});
    };
    // Debounce: coalesce the per-frame ResizeObserver bursts (island width
    // transition) into a single trailing fit once the size stops changing.
    const scheduleFit = () => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => { fitTimer = null; settleFit(); }, 100);
    };

    // Coalescing input queue: one POST in flight; keys typed meanwhile batch into
    // the next payload (ordered, no per-key round-trip pile-up).
    let inputBuf = "";
    let sending = false;
    const flushInput = () => {
      if (sending || !inputBuf) return;
      const payload = inputBuf;
      inputBuf = "";
      sending = true;
      api.sendPtyInput(sessionId, payload)
        .catch(() => {})
        .finally(() => { sending = false; flushInput(); });
    };
    let onDataDisposable = null;

    // Buffer bytes that arrive before xterm is mounted (the deferred open below),
    // then write live directly. Not a scrollback replay — just the mount-timing gap.
    const pending = [];
    const offData = onPtyData(sessionId, (f) => {
      if (!opened) { pending.push(f.data ?? ""); return; }
      term.write(f.data ?? "");
    });
    const offExit = onPtyExit(sessionId, (f) => {
      term.write(`\r\n\x1b[2m[process exited${f?.exitCode != null ? ` (${f.exitCode})` : ""}]\x1b[0m\r\n`);
      markExited(sessionId);
    });

    // Defer the mount past the frame that kicks off the island open transition —
    // term.open()+fit force a synchronous reflow, which mid-commit is the hitch.
    const raf = requestAnimationFrame(() => {
      term.open(host);
      opened = true;
      for (const d of pending) term.write(d);
      pending.length = 0;
      onDataDisposable = term.onData((data) => { inputBuf += data; flushInput(); });
      scheduleFit();
      if (active) term.focus();
    });

    ctl.current = { scheduleFit, focus: () => { if (opened) term.focus(); } };

    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      if (fitTimer) clearTimeout(fitTimer);
      ro.disconnect();
      offData();
      offExit();
      onDataDisposable?.dispose();
      term.dispose();
      ctl.current = null;
    };
  }, [sessionId]);

  // Becoming active un-hides the host (0→real size): re-fit (debounced) and focus.
  useEffect(() => {
    if (!active) return;
    ctl.current?.scheduleFit();
    ctl.current?.focus();
  }, [active, sessionId]);

  return <div className="pty-view" style={{ display: active ? "block" : "none" }} ref={hostRef} />;
}
