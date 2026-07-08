import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/client.js";
import { onPtyData, onPtyExit } from "../../state/ptyBus.js";
import { markExited } from "../../state/ptyPanelStore.js";
import { registerTerminal } from "./terminalBridge.js";

// ONE xterm.js instance per PTY session. Stays MOUNTED while inactive (parent
// hides it with display:none) so scrollback survives tab switches client-side.
//
// Sessions always open clean (no reattach/buffer replay), so incoming pty:data is
// written straight through in SSE order — no seq dedup. Wiring: xterm.onData →
// POST /pty/:id/input (coalescing send queue); pty:data → term.write.
//
// Open path is settle-gated to avoid open-time jank: the island's open animates
// the dock's width (flex-basis / slot rect, 240ms) on the main thread, and
// xterm's mount (term.open + first render/fit/focus) is a 60-130ms block — run
// mid-transition it freezes the slide (measured in WebKit, the app shell's
// engine). So the mount polls the host's width each rAF and runs only once the
// geometry has stopped changing: the slide owns the frame budget, the mount
// block lands after motion stops (where it's invisible), and the first fit
// happens at the final size — one render at the right cols/rows. Later fits
// (divider drags, panel switches) stay debounced behind a ResizeObserver.
export function TerminalView({ sessionId, active }) {
  const hostRef = useRef(null);
  const ctl = useRef(null); // { scheduleFit, focus } — for the active-tab effect
  const lastSize = useRef({ cols: 0, rows: 0 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Resolve the panel's theme colors to concrete values for xterm's ITheme
    // (xterm can't read CSS vars): match the diff/panel island bg (--surface-2)
    // and foreground (--fg) so the terminal follows the app theme in both modes.
    const root = getComputedStyle(document.documentElement);
    const cssVar = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
    const bg = cssVar("--surface-2", cssVar("--bg", "#252525"));
    const fg = cssVar("--fg", "#ebebeb");
    const accent = cssVar("--accent", fg);
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
        "monospace",
      fontSize: 12,
      theme: { background: bg, foreground: fg, cursor: accent },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // Clipboard shortcuts inside the terminal. On macOS ⌘ is the clipboard
    // modifier (Ctrl+C/V stay control bytes for the shell), so only intercept
    // plain ⌘; returning false stops xterm from also sending the key. In the
    // packaged app the Edit menu consumes these before xterm sees them and the
    // native selectors (main.swift) drive the same paths — this is the
    // browser/dev fallback.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (!(e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)) return true;
      const key = e.key.toLowerCase();
      if (key === "c" || key === "x") {
        if (!term.hasSelection()) return true; // nothing to copy → let it pass
        navigator.clipboard?.writeText(term.getSelection());
        e.preventDefault(); // buffer is read-only, so ⌘X behaves as copy
        return false;
      }
      if (key === "v") {
        navigator.clipboard?.readText().then((t) => term.paste(t)).catch(() => {});
        e.preventDefault();
        return false;
      }
      if (key === "a") { term.selectAll(); e.preventDefault(); return false; }
      return true;
    });
    const unregisterTerm = registerTerminal({ term, host });

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

    // Mount once the host's width is stable for 2 consecutive frames (strict
    // equality — sub-pixel movement near the ease's tail keeps it "unstable"
    // until the transition truly ends). A hidden host (width 0: inactive tab,
    // buried panel) never settles, so the mount also waits for visibility.
    let raf = 0;
    let lastW = -1;
    let stableFrames = 0;
    const openWhenSettled = () => {
      const w = host.getBoundingClientRect().width;
      stableFrames = w > 0 && w === lastW ? stableFrames + 1 : 0;
      lastW = w;
      if (stableFrames < 2) { raf = requestAnimationFrame(openWhenSettled); return; }
      term.open(host);
      opened = true;
      settleFit();
      for (const d of pending) term.write(d);
      pending.length = 0;
      onDataDisposable = term.onData((data) => { inputBuf += data; flushInput(); });
      if (active) term.focus();
    };
    raf = requestAnimationFrame(openWhenSettled);

    ctl.current = { scheduleFit, focus: () => { if (opened) term.focus(); } };

    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      if (fitTimer) clearTimeout(fitTimer);
      ro.disconnect();
      unregisterTerm();
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
