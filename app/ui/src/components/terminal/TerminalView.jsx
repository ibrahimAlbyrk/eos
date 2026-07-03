import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/client.js";
import { onPtyData, onPtyExit } from "../../state/ptyBus.js";
import { markExited, clearFresh } from "../../state/ptyPanelStore.js";

// ONE xterm.js instance per PTY session. Stays MOUNTED while inactive (parent
// hides it with display:none) so scrollback survives tab switches client-side.
//
// Wiring: xterm.onData → POST /pty/:id/input (per-session FIFO queue, since HTTP
// gives no ordering guarantee); ResizeObserver → FitAddon → POST resize; incoming
// pty:data frames (via ptyBus) are written to the terminal with seq dedup against
// the scrollback replayed on mount from GET /pty/:id/buffer.
export function TerminalView({ sessionId, active, fresh }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const sendChain = useRef(Promise.resolve());
  const lastSeq = useRef(-1);
  const replayed = useRef(false);
  const pending = useRef([]);
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
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const doFit = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      try { fit.fit(); } catch { return; }
      const { cols, rows } = term;
      if (cols === lastSize.current.cols && rows === lastSize.current.rows) return;
      lastSize.current = { cols, rows };
      api.resizePty(sessionId, cols, rows).catch(() => {});
    };
    doFit();

    // Per-session FIFO: each input POST awaits the prior one so keystrokes land
    // in order even though fetch resolves out of order.
    const onData = term.onData((data) => {
      sendChain.current = sendChain.current.then(() =>
        api.sendPtyInput(sessionId, data).catch(() => {})
      );
    });

    const writeFrame = (f) => {
      if (f.seq <= lastSeq.current) return;
      term.write(f.data ?? "");
      lastSeq.current = f.seq;
    };
    const offData = onPtyData(sessionId, (f) => {
      if (!replayed.current) { pending.current.push(f); return; }
      writeFrame(f);
    });
    const offExit = onPtyExit(sessionId, (f) => {
      term.write(`\r\n\x1b[2m[process exited${f?.exitCode != null ? ` (${f.exitCode})` : ""}]\x1b[0m\r\n`);
      markExited(sessionId);
    });

    const flushPending = () => {
      replayed.current = true;
      pending.current.sort((a, b) => a.seq - b.seq).forEach(writeFrame);
      pending.current = [];
    };
    if (fresh) {
      // Just-created session: no scrollback to replay — go live immediately and
      // let a later remount (panel reopen) fall back to the reattach path.
      flushPending();
      clearFresh(sessionId);
    } else {
      // Reattach: replay scrollback, then flush any live frames that raced in.
      api.getPtyBuffer(sessionId)
        .then((r) => {
          const b = r?.ok ? r.body : null;
          if (b) { term.write(b.data ?? ""); lastSeq.current = b.seq ?? -1; }
        })
        .catch(() => {})
        .finally(() => { flushPending(); doFit(); });
    }

    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);

    return () => {
      ro.disconnect();
      offData();
      offExit();
      onData.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Becoming active un-hides the host (0→real size); refit and focus so the
  // shell reflows to the panel width and takes keystrokes immediately.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    requestAnimationFrame(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      try { fit.fit(); } catch { return; }
      const { cols, rows } = term;
      if (cols !== lastSize.current.cols || rows !== lastSize.current.rows) {
        lastSize.current = { cols, rows };
        api.resizePty(sessionId, cols, rows).catch(() => {});
      }
      term.focus();
    });
  }, [active, sessionId]);

  return <div className="pty-view" style={{ display: active ? "block" : "none" }} ref={hostRef} />;
}
