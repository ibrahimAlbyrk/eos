// useStickToBottom — single owner of a chat scroller's scrollTop. Keeps the
// view pinned to the bottom while content grows, gliding there with a rAF loop
// whose target is re-read every frame: mid-flight growth just moves the
// target, so the animation never restarts and never lands short.
//
// Attribution: every own write records its value+time; a scroll event matching
// the last write (±2px, fresh) is "self". User intent comes from input
// direction (wheel-up unpins) plus a non-self upward move as the scrollbar
// fallback — never from time-based guards, which WKWebView's missing
// `scrollend` made unreliable.
//
// Growth detection is a ResizeObserver on the scroller AND the content
// element, so anything that changes height (new blocks, ProcessingLine,
// late-loading images) re-arms the glide without the component's help.
//
// A SETTLE phase follows every reset()/write(): freshly swapped content still
// materializes its content-visibility height estimates over the next frames,
// so a pinned glide would chase a receding bottom. While settling, pinned
// growth snaps instantly instead; the phase ends on user scroll intent or
// once the height holds still for a couple of frames — streaming growth
// after that glides exactly as before.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldStick, nextPinned, followStep, growthAction, settleStep } from "../lib/scrollStick.js";

const SELF_MATCH_PX = 2;
const SELF_FRESH_MS = 150;
const GLIDE_TAU_MS = 100;
// Beyond this many viewports the glide skips ahead and only eases the landing —
// a full-distance glide across a long transcript reads as motion sickness.
const MAX_GLIDE_VIEWPORTS = 2.5;

export function useStickToBottom({
  threshold = 40,
  buttonThreshold = null,
  onUserAway = null,
  onPinned = null,
  onScroll = null,
  anchor = null,
} = {}) {
  const scrollerRef = useRef(null);
  const contentRef = useRef(null);
  const pinnedRef = useRef(true);
  const prevTopRef = useRef(0);
  const ledgerRef = useRef(null);
  const rafRef = useRef(0);
  const lastFrameTsRef = useRef(0);
  // Width-resize re-anchoring (side panel open/close, sidebar collapse, divider
  // drag): WKWebView has no native scroll anchoring, so a reflow at a new width
  // drifts an unpinned transcript toward the top. anchorTokenRef holds the last
  // viewed block+offset; lastWidthRef tells a width change from normal growth.
  const anchorTokenRef = useRef(null);
  const lastWidthRef = useRef(0);
  const [showJumpBtn, setShowJumpBtn] = useState(false);

  const cbRef = useRef({});
  cbRef.current = { onUserAway, onPinned, onScroll, anchor };

  const reducedMotionRef = useRef(undefined);
  if (reducedMotionRef.current === undefined) {
    reducedMotionRef.current =
      typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  }

  const ownWrite = useCallback((el, top) => {
    const clamped = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    ledgerRef.current = { top: clamped, t: performance.now() };
    el.scrollTop = clamped;
    prevTopRef.current = el.scrollTop;
  }, []);

  const settlingRef = useRef(false);
  const settleRafRef = useRef(0);

  const endSettle = useCallback(() => {
    settlingRef.current = false;
    if (settleRafRef.current) cancelAnimationFrame(settleRafRef.current);
    settleRafRef.current = 0;
  }, []);

  // Arm the settle phase and start its exit watcher (a rAF loop feeding
  // settleStep). The watcher, not the ResizeObserver, decides "stable": the
  // observer only fires ON change, so it can never see stillness.
  const beginSettle = useCallback(() => {
    endSettle();
    settlingRef.current = true;
    let state = null;
    const tick = () => {
      settleRafRef.current = 0;
      const el = scrollerRef.current;
      if (!el || !settlingRef.current) return;
      state = settleStep(state, el.scrollHeight);
      if (state.done) { settlingRef.current = false; return; }
      settleRafRef.current = requestAnimationFrame(tick);
    };
    settleRafRef.current = requestAnimationFrame(tick);
  }, [endSettle]);

  // Remember the block at the viewport top so a later width-driven reflow can
  // restore it. Only while reading history (unpinned) — a pinned view re-pins to
  // the bottom on resize and needs no anchor.
  const captureAnchorToken = useCallback(() => {
    const a = cbRef.current.anchor;
    anchorTokenRef.current = a && !pinnedRef.current
      ? a.capture(scrollerRef.current, contentRef.current)
      : null;
  }, []);

  const stopFollow = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const stepRef = useRef(null);
  stepRef.current = (ts) => {
    rafRef.current = 0;
    const el = scrollerRef.current;
    if (!el || !pinnedRef.current) return;
    const target = el.scrollHeight - el.clientHeight;
    let cur = el.scrollTop;
    const dist = target - cur;
    if (dist <= 0.5) return;
    if (reducedMotionRef.current?.matches) {
      ownWrite(el, target);
      return;
    }
    const dt = Math.min(64, Math.max(1, ts - lastFrameTsRef.current));
    lastFrameTsRef.current = ts;
    const maxGlide = el.clientHeight * MAX_GLIDE_VIEWPORTS;
    if (dist > maxGlide) cur = target - maxGlide;
    ownWrite(el, followStep(cur, target, dt, { tau: GLIDE_TAU_MS }));
    rafRef.current = requestAnimationFrame((t) => stepRef.current(t));
  };

  const startFollow = useCallback(() => {
    if (rafRef.current) return;
    lastFrameTsRef.current = performance.now();
    rafRef.current = requestAnimationFrame((t) => stepRef.current(t));
  }, []);

  const updateBtn = useCallback(() => {
    if (buttonThreshold == null) return;
    const el = scrollerRef.current;
    if (!el) return;
    const overflows = el.scrollHeight > el.clientHeight;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpBtn(overflows && dist >= buttonThreshold);
  }, [buttonThreshold]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const top = el.scrollTop;
      const distance = el.scrollHeight - top - el.clientHeight;
      const deltaTop = top - prevTopRef.current;
      prevTopRef.current = top;
      const ledger = ledgerRef.current;
      const isSelf = ledger != null
        && Math.abs(top - ledger.top) <= SELF_MATCH_PX
        && performance.now() - ledger.t < SELF_FRESH_MS;
      const was = pinnedRef.current;
      const now = nextPinned(was, { distance, deltaTop, isSelf, threshold });
      pinnedRef.current = now;
      if (now && !was) cbRef.current.onPinned?.();
      if (!now && !isSelf) { endSettle(); cbRef.current.onUserAway?.(top); }
      if (!now) stopFollow();
      // Same decision as the ResizeObserver: settling corrections are instant.
      else if (distance > 1) {
        if (settlingRef.current) ownWrite(el, el.scrollHeight);
        else startFollow();
      }
      updateBtn();
      cbRef.current.onScroll?.(el);
      captureAnchorToken();
    };

    const handleWheel = (e) => {
      if (e.deltaY >= 0 || !pinnedRef.current) return;
      if (el.scrollHeight - el.clientHeight <= 1) return;
      pinnedRef.current = false;
      endSettle();
      stopFollow();
      cbRef.current.onUserAway?.(el.scrollTop);
      updateBtn();
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    el.addEventListener("wheel", handleWheel, { passive: true });
    lastWidthRef.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      // Ignore park/unpark (content-visibility:hidden toggles width to/from 0) —
      // that path is owned by the host's parked→active restore.
      const widthChanged = w > 0 && lastWidthRef.current > 0 && Math.abs(w - lastWidthRef.current) > 0.5;
      lastWidthRef.current = w;
      const act = growthAction({ pinned: pinnedRef.current, settling: settlingRef.current });
      if (act === "snap") {
        ownWrite(el, el.scrollHeight);
      } else if (act === "follow") {
        startFollow();
      } else if (widthChanged) {
        // Reflow at a new width: put the previously viewed block back at its old
        // viewport offset, synchronously (RO runs before paint → no flash).
        const a = cbRef.current.anchor;
        const token = anchorTokenRef.current;
        if (a && token != null) {
          const top = a.resolve(token, el, contentRef.current);
          if (top != null) { stopFollow(); ownWrite(el, top); }
        }
      }
      updateBtn();
    });
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => {
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("wheel", handleWheel);
      ro.disconnect();
      stopFollow();
      endSettle();
    };
  }, [threshold, startFollow, stopFollow, updateBtn, ownWrite, captureAnchorToken, endSettle]);

  const scrollToBottom = useCallback(({ instant = false } = {}) => {
    const el = scrollerRef.current;
    if (!el) return;
    endSettle(); // explicit user jump — the glide is the point
    const was = pinnedRef.current;
    pinnedRef.current = true;
    if (!was) cbRef.current.onPinned?.();
    if (instant || reducedMotionRef.current?.matches) {
      stopFollow();
      ownWrite(el, el.scrollHeight);
    } else {
      startFollow();
    }
    updateBtn();
  }, [ownWrite, startFollow, stopFollow, updateBtn, endSettle]);

  // Owned write for positioning that is not "go to the bottom": initial
  // restore (pin:"auto" re-derives the pin from where we landed) and the
  // prepend compensation after backward pagination (pin:"keep").
  const write = useCallback((top, { pin = "auto" } = {}) => {
    const el = scrollerRef.current;
    if (!el) return;
    stopFollow();
    ownWrite(el, top);
    if (pin === "auto") {
      pinnedRef.current = shouldStick(
        { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight },
        threshold,
      );
    } else if (pin !== "keep") {
      pinnedRef.current = Boolean(pin);
    }
    // A programmatic restore that lands mid-history (initial restore, prepend
    // compensation, parked→active flip) seeds the anchor so a width resize can
    // re-pin even before the user scrolls.
    captureAnchorToken();
    updateBtn();
    beginSettle();
  }, [ownWrite, stopFollow, updateBtn, threshold, captureAnchorToken, beginSettle]);

  // Content-swap reset (agent switch). Unpinned by default so the swap's
  // resize churn doesn't glide anywhere before the initial write decides.
  const reset = useCallback(({ pinned = false } = {}) => {
    stopFollow();
    pinnedRef.current = pinned;
    ledgerRef.current = null;
    anchorTokenRef.current = null;
    prevTopRef.current = scrollerRef.current?.scrollTop ?? 0;
    beginSettle();
  }, [stopFollow, beginSettle]);

  // User intent like wheel-up, but from a disclosure toggle: the content is
  // about to grow under the user's click, so stop following and unpin —
  // otherwise the follow glide drags the expanded detail past the viewport.
  const hold = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !pinnedRef.current) return;
    if (el.scrollHeight - el.clientHeight <= 1) return;
    pinnedRef.current = false;
    endSettle();
    stopFollow();
    cbRef.current.onUserAway?.(el.scrollTop);
    updateBtn();
  }, [stopFollow, updateBtn, endSettle]);

  const isPinned = useCallback(() => pinnedRef.current, []);

  return useMemo(
    () => ({ scrollerRef, contentRef, isPinned, scrollToBottom, write, reset, hold, showJumpBtn }),
    [isPinned, scrollToBottom, write, reset, hold, showJumpBtn],
  );
}
