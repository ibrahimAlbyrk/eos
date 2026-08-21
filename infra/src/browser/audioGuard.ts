// The injected audio guard (Page.addScriptToEvaluateOnNewDocument — late
// injection provably fails, and also falsely reports a load-time AudioContext
// as silent). Proven recipe (audio spike): replace the `muted` accessor on
// HTMLMediaElement.prototype, wrap play(), and register+suspend AudioContext
// with a no-op resume while force-muted. It survives a page hammering
// `muted=false; volume=1; play()` every 100ms. NEVER mute by zeroing volume —
// unmute could not restore the user's level.
//
// The same script populates the audible probe (__eosIsAudible) that
// listTabs reports. Force-mute state changes are pushed by re-registering the
// script with a new initial value (so post-navigation documents inherit it)
// plus flipping live documents via __eosSetForceMuted.

export function audioGuardSource(initialForceMuted: boolean): string {
  return `(() => {
  if (window.__eosAudio) return;
  const S = { forceMuted: ${initialForceMuted}, media: new Set(), contexts: new Set() };
  window.__eosAudio = S;
  const proto = HTMLMediaElement.prototype;
  const nat = Object.getOwnPropertyDescriptor(proto, "muted");
  Object.defineProperty(proto, "muted", {
    configurable: true,
    // The page sees its own desired state; the native flag holds the
    // effective one (desired OR force). Restoring on unmute is exact.
    get() { return this.__eosDesiredMuted !== undefined ? this.__eosDesiredMuted : nat.get.call(this); },
    set(v) {
      S.media.add(this);
      this.__eosDesiredMuted = !!v;
      nat.set.call(this, S.forceMuted || !!v);
    },
  });
  const play = proto.play;
  proto.play = function (...a) {
    S.media.add(this);
    if (S.forceMuted) nat.set.call(this, true);
    return play.apply(this, a);
  };
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const Orig = window[name];
    if (!Orig) continue;
    const Wrapped = function (...a) {
      const ctx = new Orig(...a);
      S.contexts.add(ctx);
      ctx.__eosResume = ctx.resume.bind(ctx);
      ctx.resume = () => (S.forceMuted ? Promise.resolve() : ctx.__eosResume());
      if (S.forceMuted) { try { ctx.suspend(); } catch {} }
      return ctx;
    };
    Wrapped.prototype = Orig.prototype;
    window[name] = Wrapped;
  }
  window.__eosSetForceMuted = (m) => {
    S.forceMuted = !!m;
    for (const el of S.media) {
      try { nat.set.call(el, S.forceMuted || (el.__eosDesiredMuted !== undefined ? el.__eosDesiredMuted : nat.get.call(el))); } catch {}
    }
    for (const ctx of S.contexts) {
      try { if (S.forceMuted) ctx.suspend(); else if (ctx.state === "suspended") ctx.__eosResume(); } catch {}
    }
    // Same-origin iframes get their own guard instance — flip them too.
    // Cross-origin frames are out of reach from here (known limitation).
    for (const f of document.querySelectorAll("iframe")) {
      try { f.contentWindow.__eosSetForceMuted && f.contentWindow.__eosSetForceMuted(m); } catch {}
    }
  };
  // True effective (native) muted state — the test/diagnostic peephole, since
  // the patched getter deliberately reports the page's desired value.
  window.__eosEffectiveMuted = (el) => nat.get.call(el);
  window.__eosIsAudible = () => {
    for (const el of S.media) {
      try { if (!el.paused && !nat.get.call(el) && el.volume > 0 && el.readyState >= 2) return true; } catch {}
    }
    for (const ctx of S.contexts) {
      try { if (ctx.state === "running") return true; } catch {}
    }
    return false;
  };
  // Push audible-state EDGES to the daemon via the __eosNotify CDP binding
  // (Runtime.addBinding) so the tab strip updates without the daemon polling
  // every tab: zero CDP traffic while nothing changes.
  let lastAudible = false;
  setInterval(() => {
    try {
      const a = window.__eosIsAudible();
      if (a !== lastAudible) {
        lastAudible = a;
        if (typeof window.__eosNotify === "function") window.__eosNotify("audible:" + a);
      }
    } catch {}
  }, 1000);
})();`;
}
