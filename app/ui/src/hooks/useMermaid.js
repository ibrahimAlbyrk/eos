import { useEffect, useSyncExternalStore } from "react";
import { currentTheme } from "../settings/theme.js";
import { renderMermaid } from "../lib/mermaid.js";

// Resolved (light|dark) theme, reactive. Subscribes to the data-theme attribute
// on <html> — the SAME attribute theme.js flips — so a re-render fires exactly
// when the CSS variables have actually changed, never a frame before. That
// timing is why Mermaid, which reads concrete computed colors, gets fresh ones.
function subscribeTheme(cb) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}

export function useResolvedTheme() {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => "dark");
}

let idCounter = 0;

function rawSourceEl(src) {
  const pre = document.createElement("pre");
  pre.className = "mermaid-src";
  pre.textContent = src;
  return pre;
}

function showError(block, src, err) {
  block.classList.remove("mermaid-loading");
  block.classList.add("mermaid-error");
  block.innerHTML = "";
  const box = document.createElement("div");
  box.className = "mermaid-error-box";
  const msg = document.createElement("div");
  msg.className = "mermaid-error-msg";
  msg.textContent = (err instanceof Error ? err.message : String(err)) || "Diagram failed to render";
  box.appendChild(msg);
  box.appendChild(rawSourceEl(src));
  block.appendChild(box);
}

// Hydrates the placeholder <div class="mermaid-block"> nodes that renderMarkdown()
// emits (source carried as escaped text content) into SVG, in place, after the
// HTML is injected.
// Re-runs on html/theme.
//
// opts.gate — a "settled" flag for streaming text. While false, a diagram that
// fails to parse (still mid-stream) keeps its raw source visible and is retried
// on the next html update instead of flashing an error box; a genuine syntax
// error only surfaces once the text has settled.
export function useMermaid(ref, html, theme, opts = {}) {
  const settled = opts.gate === undefined ? true : Boolean(opts.gate);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Select by class: a block whose source is somehow empty must still be
    // surfaced, never left blank.
    const blocks = el.querySelectorAll(".mermaid-block");
    if (!blocks.length) return;
    let cancelled = false;
    blocks.forEach((block) => {
      // Capture the source (the escaped text content renderMarkdown emitted) once,
      // before hydration replaces the node with an SVG whose textContent would be
      // the diagram's labels, not its source. Fresh nodes from a React html update
      // re-capture; the flag only guards re-runs on the same node (theme change).
      if (block._mmdSrc === undefined) block._mmdSrc = block.textContent || "";
      const src = block._mmdSrc;
      // No usable source (missing/empty attr) — can't render and won't recover,
      // so show a clear error instead of an empty box, regardless of the gate.
      if (!src.trim()) {
        if (block._mmdKey !== "\x00missing") {
          showError(block, src, new Error("Diagram source missing"));
          block._mmdKey = "\x00missing";
        }
        return;
      }
      // Already rendered as SVG for this exact theme+src — don't double-hydrate.
      if (block._mmdKey === theme + "\x00" + src) return;
      // Show the raw source as the loading/fallback view until the SVG lands.
      if (block._mmdRaw !== src) {
        block.innerHTML = "";
        block.appendChild(rawSourceEl(src));
        block._mmdRaw = src;
      }
      block.classList.add("mermaid-loading");
      renderMermaid(`mmd-${idCounter++}`, src, theme).then(
        ({ svg }) => {
          if (cancelled) return;
          block.classList.remove("mermaid-loading", "mermaid-error");
          block.innerHTML = svg;
          block._mmdKey = theme + "\x00" + src;
        },
        (err) => {
          if (cancelled) return;
          block.classList.remove("mermaid-loading");
          // Streaming and not settled — keep raw source, retry on next update.
          if (!settled) return;
          showError(block, src, err);
          block._mmdKey = theme + "\x00" + src; // stop retrying a broken diagram
        },
      );
    });
    return () => { cancelled = true; };
    // ref is a stable useRef container; html/theme/settled are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, theme, settled]);
}
