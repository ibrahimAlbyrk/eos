import { useEffect, useRef } from "react";
import { keymap } from "./index.js";

// Mount ONCE (CodeView). One capture-phase window listener routes every keydown
// through the keymap; the matched binding decides what runs and whether to
// preventDefault. Replaces N per-hook window listeners with one.
export function useGlobalKeymap(getCtx) {
  const getCtxRef = useRef(getCtx);
  getCtxRef.current = getCtx;
  useEffect(() => {
    const onKey = (e) => {
      const ctx = getCtxRef.current ? getCtxRef.current() : {};
      keymap.handle(e, ctx);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

// Register a binding for this component's lifetime. `deps` mirror the original
// per-hook useEffect deps so the binding's closures stay fresh (re-register on
// change) — the same reactivity the listeners it replaces had.
export function useKeybinding(binding, deps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => keymap.register(binding), deps);
}
