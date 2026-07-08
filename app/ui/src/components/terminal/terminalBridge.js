// Registry of live xterm terminals so app-level code can find the one the user
// is currently typing in. xterm renders to a canvas and focuses a hidden helper
// <textarea>, so DOM focus lands inside the terminal host — a `host.contains`
// check against the active element identifies the focused terminal.
//
// Two consumers:
//   - the keymap focus guard (isTerminalFocused) — app hotkeys yield to a
//     focused terminal (see keymap.js).
//   - the native Edit-menu selectors (app/main.swift) — ⌘C/⌘X/⌘V/⌘A are consumed
//     by AppKit before the WebView's keydown, so they drive clipboard here via
//     window.__eosTerm instead of xterm's own key handler.

const terminals = new Set(); // entries: { term, host }

export function registerTerminal(entry) {
  terminals.add(entry);
  return () => { terminals.delete(entry); };
}

// Pure resolver (no DOM globals) so the registry is unit-testable: returns the
// term whose host contains `active`, else null.
export function focusedTerminalFor(active) {
  if (!active) return null;
  for (const t of terminals) {
    if (t.host.contains(active)) return t.term;
  }
  return null;
}

function focusedTerminal() {
  return focusedTerminalFor(typeof document !== "undefined" ? document.activeElement : null);
}

export function isTerminalFocused() {
  return focusedTerminal() !== null;
}

if (typeof window !== "undefined") {
  window.__eosTerm = {
    isFocused: () => isTerminalFocused(),
    // Non-null only when the terminal is focused AND has a selection — the native
    // Copy/Cut selectors write this string to NSPasteboard, else fall through to
    // WebKit's native copy of the DOM selection (composer, dialogs).
    getSelectionIfFocused: () => {
      const term = focusedTerminal();
      return term && term.hasSelection() ? term.getSelection() : null;
    },
    selectAll: () => { focusedTerminal()?.selectAll(); },
    // The native Paste selector reads NSPasteboard (navigator.clipboard.readText
    // is permission-gated in WKWebView) and hands the bytes here base64-encoded.
    pasteBase64: (b64) => {
      const term = focusedTerminal();
      if (!term) return;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      term.paste(new TextDecoder().decode(bytes));
    },
  };
}
