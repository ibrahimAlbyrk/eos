// Pure keyboard-binding registry — mirrors search/registry.js. A binding is a
// plain object:
//   { match(e) -> bool, when?(ctx) -> bool, priority?=0, terminalSafe?=false, run(ctx, e) }
// terminalSafe: still fires while the right-panel terminal is focused (default:
// app hotkeys yield to the terminal — see resolve()).
// The single global listener (useGlobalKeymap) routes every keydown here; each
// binding site stays decoupled (Open/Closed: add a hotkey by registering a
// binding — the listener never changes). No DOM here: events are matched as
// plain objects, so the whole thing is unit-testable without a browser.

// Plain-⌘ guard (the app is mac-only): Cmd down, no other modifier. Exported
// for bindings whose key set isn't a single combo (e.g. the Cmd+1..9 range).
export function isMod(e) {
  return Boolean(e.metaKey) && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

function matchKey(e, token, useCode) {
  if (useCode) {
    if (/^[a-z]$/.test(token)) return e.code === "Key" + token.toUpperCase();
    if (/^[0-9]$/.test(token)) return e.code === "Digit" + token;
    return e.code === token;
  }
  const k = (e.key || "").toLowerCase();
  if (token === "space") return k === " " || k === "space";
  return k === token;
}

// Build a match(e) from a combo spec like "mod+g", "mod+ctrl+t", "mod+shift+enter".
// mod = metaKey. Modifiers must match EXACTLY (a modifier not named must be UP) —
// this preserves the strict guards the per-hook listeners used, e.g. plain Cmd+T
// must stay disjoint from Cmd+Ctrl+T. opts.code matches e.code (layout
// independent) instead of e.key.
export function combo(spec, opts = {}) {
  const parts = spec.toLowerCase().split("+");
  const want = {
    mod: parts.includes("mod"),
    ctrl: parts.includes("ctrl"),
    alt: parts.includes("alt"),
    shift: parts.includes("shift"),
  };
  const key = parts[parts.length - 1];
  return (e) =>
    Boolean(e.metaKey) === want.mod &&
    Boolean(e.ctrlKey) === want.ctrl &&
    Boolean(e.altKey) === want.alt &&
    Boolean(e.shiftKey) === want.shift &&
    matchKey(e, key, Boolean(opts.code));
}

export function createKeymap() {
  const bindings = [];

  return {
    register(binding) {
      bindings.push(binding);
      return () => {
        const i = bindings.indexOf(binding);
        if (i !== -1) bindings.splice(i, 1);
      };
    },

    bindings() {
      return [...bindings];
    },

    // The highest-priority enabled binding whose match accepts the event. Ties:
    // the most recently registered wins (a freshly-mounted modal/pane overrides
    // a global default) — the same outcome a later capture listener used to get.
    resolve(e, ctx) {
      let best = null;
      for (const b of bindings) {
        if (!b.match(e)) continue;
        // A focused terminal owns the keyboard: app hotkeys yield unless they opt
        // in via terminalSafe (e.g. pane navigation stays live from the terminal).
        if (ctx.terminalFocused && !b.terminalSafe) continue;
        if (b.when && !b.when(ctx)) continue;
        if (!best || (b.priority || 0) >= (best.priority || 0)) best = b;
      }
      return best;
    },

    // Resolve + run. Returns true if a binding handled the event (the binding's
    // run owns preventDefault/stopPropagation, exactly as the old listeners did).
    handle(e, ctx) {
      const b = this.resolve(e, ctx);
      if (!b) return false;
      b.run(ctx, e);
      return true;
    },
  };
}
