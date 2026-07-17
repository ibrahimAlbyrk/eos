import { useEffect } from "react";
import { decideLinkAction } from "../lib/mdLinkResolve.js";

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// marked (v18) emits no heading ids, so match by GitHub-style slug of the text.
function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-");
}

function findHeadingBySlug(container, id) {
  const want = id.toLowerCase();
  for (const h of container.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (slugify(h.textContent || "") === want) return h;
  }
  return null;
}

function scrollToFragment(container, rawHref) {
  const id = decode(rawHref.slice(1));
  if (!id) return;
  let target = null;
  try { target = container.querySelector(`#${CSS.escape(id)}`); } catch { /* invalid selector */ }
  if (!target) target = findHeadingBySlug(container, id);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Intercepts anchor clicks inside a rendered markdown preview so cross-file
// links resolve in-app instead of escaping to the OS (macOS "no application"
// popup). Mirrors useMermaid's (ref, html, …) signature and re-runs on
// html/path. A relative .md link opens via the caller's onOpenPath (the scoped
// file viewer); an in-doc #fragment scrolls to the target heading; everything
// else (external links, non-.md relative links) is left to bubble as before.
export function useMarkdownLinks(ref, html, path, onOpenPath) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !path || !onOpenPath) return;
    const onClick = (e) => {
      // The click target is frequently a nested node (<code>, <strong>, text)
      // inside the <a>, so resolve the anchor with closest, not target itself.
      const anchor = e.target?.closest?.("a");
      if (!anchor || !el.contains(anchor)) return;
      // The RAW authored href — anchor.href is already mis-resolved to eos://app/…
      const href = anchor.getAttribute("href");
      if (href == null) return;
      const { action, path: resolved } = decideLinkAction(path, href);
      if (action === "ignore") return; // external / non-.md relative → let it bubble
      e.preventDefault();
      if (action === "fragment") scrollToFragment(el, href);
      else onOpenPath(resolved);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
    // ref is a stable useRef container; html/path are the real triggers
    // (onOpenPath is a stable scoped action).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, path]);
}
