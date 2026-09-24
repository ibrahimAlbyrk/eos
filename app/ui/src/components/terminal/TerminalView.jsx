import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/client.js";
import { onPtyData, onPtyExit } from "../../state/ptyBus.js";
import { markExited } from "../../state/ptyPanelStore.js";
import { registerTerminal } from "./terminalBridge.js";
import { createReplayGate } from "./replayGate.js";
import { macEditBytes, shellEscapePath } from "./terminalKeys.js";
import { createWheelAccumulator, sgrWheelReports } from "./mouseWheel.js";
import { openTerminalLink, oscLinkHandler } from "./terminalLinks.js";
import { claimNextDrop } from "../../lib/nativeBridge.js";
import { CLAUDE_SESSION_OSC, parseClaudeSessionOsc } from "../../lib/claudeSessionOsc.js";

// ONE xterm.js instance per PTY session. Stays MOUNTED while inactive (parent
// hides it with display:none) so scrollback survives tab switches client-side.
//
// REATTACH: a fresh xterm has no scrollback, so on mount we fetch the session's
// server ring buffer (GET /pty/:id/buffer) and replay it, then feed live pty:data
// through a replayGate that drops any frame the buffer already covers (seq <=
// buffer seq) — so a reopened panel restores prior output with no duplicated
// lines. Wiring: xterm.onData → POST /pty/:id/input (coalescing send queue);
// pty:data → replayGate → term.write.
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
//
// Optional (Code view workspace): `visible` (shown while not `active` — split
// panes are all on screen, only the focused one takes keyboard focus),
// `fontSize`, `surface` (the CSS var the body sits on), `palette` (ANSI colors),
// `onTitle` (OSC title changes), `onClaudeSession` (Claude Code session id
// reported by its session hook — lib/claudeSessionOsc) and `shiftEnter` (bytes Shift+Enter sends —
// Claude Code reads ESC+CR as a newline, not submit).
export function TerminalView({
  sessionId, active, visible = active, fontSize = 11.5, surface = "--panel", palette, onTitle, onClaudeSession, shiftEnter,
}) {
  const hostRef = useRef(null);
  const ctl = useRef(null); // { scheduleFit, focus } — for the active-tab effect
  const lastSize = useRef({ cols: 0, rows: 0 });
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onClaudeSessionRef = useRef(onClaudeSession);
  onClaudeSessionRef.current = onClaudeSession;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Resolve the panel's theme colors to concrete values for xterm's ITheme
    // (xterm can't read CSS vars): the terminal body shares the side panel
    // background (--panel) with --fg text, so it reads as one surface.
    const root = getComputedStyle(document.documentElement);
    const cssVar = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
    const bg = cssVar(surface, cssVar("--bg", "#171717"));
    const fg = cssVar("--fg", "#ebebeb");
    const accent = cssVar("--accent", fg);
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
        "monospace",
      fontSize,
      theme: { background: bg, foreground: fg, cursor: accent, ...palette },
      linkHandler: oscLinkHandler,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon(openTerminalLink)); // plain-text URLs

    // Clipboard shortcuts inside the terminal. On macOS ⌘ is the clipboard
    // modifier (Ctrl+C/V stay control bytes for the shell), so only intercept
    // plain ⌘; returning false stops xterm from also sending the key. In the
    // packaged app the Edit menu consumes these before xterm sees them and the
    // native selectors (main.swift) drive the same paths — this is the
    // browser/dev fallback.
    term.attachCustomKeyEventHandler((e) => {
      if (shiftEnter && e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === "keydown") { inputBuf += shiftEnter; flushInput(); }
        e.preventDefault();
        return false;
      }
      if (e.type !== "keydown") return true;
      const editBytes = macEditBytes(e);
      if (editBytes) { inputBuf += editBytes; flushInput(); e.preventDefault(); return false; }
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

    // Wheel inside a mouse-tracking TUI (Claude Code): Ghostty-rate SGR reports
    // (see mouseWheel.js). xterm keeps the wheel for its own scrollback, and for
    // non-SGR encodings we can't emit — only this path is overridden.
    let sgrMouse = false;
    const trackSgr = (on) => (params) => { if (params.includes(1006)) sgrMouse = on; return false; };
    const sgrOn = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackSgr(true));
    const sgrOff = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackSgr(false));
    const wheelSteps = createWheelAccumulator();
    term.attachCustomWheelEventHandler((e) => {
      const mode = term.modes.mouseTrackingMode;
      if (!sgrMouse || mode === "none" || mode === "x10" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return true;
      const screen = term.element?.querySelector(".xterm-screen");
      if (!screen) return true;
      e.preventDefault();
      const r = screen.getBoundingClientRect();
      const cellH = r.height / term.rows;
      const steps = wheelSteps(e, cellH, term.rows);
      if (!steps) return false;
      const col = Math.min(term.cols, Math.max(1, Math.floor((e.clientX - r.left) / (r.width / term.cols)) + 1));
      const row = Math.min(term.rows, Math.max(1, Math.floor((e.clientY - r.top) / cellH) + 1));
      inputBuf += sgrWheelReports(steps, col, row);
      flushInput();
      return false;
    });
    const unregisterTerm = registerTerminal({ term, host });
    const titleDisposable = term.onTitleChange((t) => onTitleRef.current?.(t));
    const claudeSessionDisposable = term.parser.registerOscHandler(CLAUDE_SESSION_OSC, (data) => {
      const id = parseClaudeSessionOsc(data);
      if (id) onClaudeSessionRef.current?.(id);
      return true;
    });

    // Finder drop → paste the escaped paths, like Ghostty. The preload resolves
    // real paths and delivers them via the native bridge after this DOM event.
    const onDrop = (e) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
      claimNextDrop((entries) => {
        const paths = entries.map((x) => x.path).filter(Boolean);
        if (!paths.length) return;
        term.paste(paths.map(shellEscapePath).join(" ") + " ");
        term.focus();
      });
    };
    host.addEventListener("drop", onDrop);

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

    // Single write sink: bytes queue in `pending` until xterm's deferred open
    // (below), then flush in order. `disposed` guards the async buffer fetch
    // resolving after unmount — the promise can't be cancelled.
    let disposed = false;
    const pending = [];
    const writeBytes = (data) => {
      if (disposed || !data) return;
      if (opened) term.write(data);
      else pending.push(data);
    };
    // Reattach: replay the server scrollback first, then live frames deduped by
    // seq. Live frames arriving before the buffer resolves are held by the gate
    // so scrollback never interleaves with (or double-renders) live output.
    const gate = createReplayGate(writeBytes);
    const offData = onPtyData(sessionId, (f) => gate.frame(f));
    api.getPtyBuffer(sessionId)
      .then((r) => gate.replay(r?.ok ? r.body : null))
      .catch(() => gate.replay(null));
    const offExit = onPtyExit(sessionId, (f) => {
      term.write(`\r\n\x1b[2m[process exited${f?.exitCode != null ? ` (${f.exitCode})` : ""}]\x1b[0m\r\n`);
      markExited(sessionId);
    });

    // Mount once the host's width is stable for 2 consecutive frames (strict
    // equality — sub-pixel movement near the ease's tail keeps it "unstable"
    // until the transition truly ends). A hidden host (width 0: inactive tab,
    // buried panel) never settles, so the mount also waits for visibility.
    // GPU renderer: Claude Code repaints the whole screen per scroll step, which
    // the DOM renderer can't keep up with. Held only while the terminal is on
    // screen — a hidden one (inactive tab, other view) releases its WebGL context
    // (browsers cap live contexts at ~16) and falls back to the DOM renderer,
    // which xterm pauses while hidden anyway. Context loss → DOM renderer too.
    let webgl = null;
    let onScreen = false;
    const setGpu = (on) => {
      if (!opened || on === Boolean(webgl)) return;
      if (!on) { webgl.dispose(); webgl = null; return; }
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); if (webgl === addon) webgl = null; });
        term.loadAddon(addon);
        webgl = addon;
      } catch { /* no WebGL2 → DOM renderer */ }
    };
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      setGpu(onScreen);
    });
    io.observe(host);

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
      setGpu(onScreen);
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
      disposed = true;
      cancelAnimationFrame(raf);
      if (fitTimer) clearTimeout(fitTimer);
      ro.disconnect();
      io.disconnect();
      host.removeEventListener("drop", onDrop);
      unregisterTerm();
      offData();
      offExit();
      onDataDisposable?.dispose();
      titleDisposable.dispose();
      sgrOn.dispose();
      sgrOff.dispose();
      claudeSessionDisposable.dispose();
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

  return <div className="pty-view" style={{ display: visible ? "block" : "none" }} ref={hostRef} />;
}
