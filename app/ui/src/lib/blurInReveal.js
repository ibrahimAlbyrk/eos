// Word-by-word blur-in reveal for freshly arrived agent messages. Words are
// temporarily wrapped in spans so each can animate with a staggered delay;
// clearBlurIn() unwraps and re-normalizes afterwards because find-in-page
// matches ranges within single text nodes — split words would break
// multi-word queries.

const WORD_DELAY_MS = 14;
const MAX_STAGGER_MS = 600;
const ANIM_MS = 220;

const isSpace = (s) => /^\s+$/.test(s);

// Text nodes (split into word/space parts) in document order; <pre> blocks
// count as a single unit and animate whole — word-wrapping inside code would
// break its layout.
function collectTargets(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        return n.tagName === "PRE" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return n.parentElement?.closest("pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      targets.push({ el: node, words: 1 });
    } else {
      const parts = node.textContent.split(/(\s+)/).filter(Boolean);
      const words = parts.filter((p) => !isSpace(p)).length;
      if (words > 0) targets.push({ node, parts, words });
    }
  }
  return targets;
}

// Animates words at index >= fromWord; earlier ones are already on screen
// (a block that grew across polls reveals only its appended tail).
// Returns { total, settleMs } — total feeds the caller's next fromWord,
// settleMs is when clearBlurIn() can safely run.
export function applyBlurIn(root, fromWord = 0) {
  const targets = collectTargets(root);
  const total = targets.reduce((n, t) => n + t.words, 0);
  const fresh = total - fromWord;
  if (fresh <= 0) return { total, settleMs: 0 };
  const step = Math.min(WORD_DELAY_MS, MAX_STAGGER_MS / fresh);
  const delayAt = (idx) => Math.round((idx - fromWord) * step) + "ms";

  let idx = 0;
  for (const t of targets) {
    if (t.el) {
      if (idx >= fromWord) {
        t.el.classList.add("blur-in");
        t.el.style.animationDelay = delayAt(idx);
      }
      idx += t.words;
      continue;
    }
    if (idx + t.words <= fromWord) { idx += t.words; continue; }
    const frag = document.createDocumentFragment();
    for (const part of t.parts) {
      if (isSpace(part) || idx < fromWord) {
        frag.append(part);
      } else {
        const s = document.createElement("span");
        s.className = "blur-word";
        s.style.animationDelay = delayAt(idx);
        s.textContent = part;
        frag.append(s);
      }
      if (!isSpace(part)) idx += 1;
    }
    t.node.replaceWith(frag);
  }
  return { total, settleMs: Math.round((fresh - 1) * step) + ANIM_MS };
}

export function clearBlurIn(root) {
  for (const el of root.querySelectorAll(".blur-in")) {
    el.classList.remove("blur-in");
    el.style.removeProperty("animation-delay");
    if (!el.getAttribute("class")) el.removeAttribute("class");
  }
  for (const s of root.querySelectorAll("span.blur-word")) {
    s.replaceWith(s.firstChild ?? "");
  }
  root.normalize();
}
