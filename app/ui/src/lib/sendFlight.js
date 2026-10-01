// Send flight — on send, the composer card shrinks into the new user bubble.
// A body-level ghost that IS a `.msg-user .b` (so it lands pixel-identical)
// starts on the card's rect and springs to the bubble's LIVE rect, re-read
// every frame because the pinned transcript glides while it flies. The real
// bubble stays hidden until the ghost hands off. Material (clear glass
// condensing into the bubble blue) and the text crossfade are CSS:
// `.send-flight` in styles/transcript.css.

const MOVE_MS = 640;
const HANDOFF_MS = 1200; // the material has settled by then
const WAIT_MS = 1000;    // the bubble renders after attachments resolve
const FADE_MS = 160;
const PIN_SLACK_PX = 48;

// Damped spring (~3% overshoot) over t∈[0,1], at rest by t=1.
export function flightSpring(t) {
  if (t >= 1) return 1;
  const zeta = 0.74, omega = 9;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}

const lerp = (a, b, p) => a + (b - a) * p;

// The composer and its transcript are siblings somewhere up the pane tree.
function transcriptOf(el) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const tx = n.querySelector(".tx-pane.on");
    if (tx) return tx;
  }
  return null;
}

// A scrolled-up reader keeps their place — the new bubble lands off-screen.
function isPinned(tx) {
  const wrap = tx.querySelector(".messages-wrap");
  return Boolean(wrap) && wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < PIN_SLACK_PX;
}

// Copied, not inherited: the ghost lives under <body>, and any drift in the
// metrics re-wraps the text so the last line spills out of the bubble.
const typography = (cs) => ({ font: cs.font, letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing });

function layer(className, nodes, style) {
  const el = document.createElement("div");
  el.className = className;
  el.append(...nodes);
  Object.assign(el.style, style);
  return el;
}

// Call BEFORE the editor is cleared: the ghost starts as a copy of its text.
export function launchSendFlight(editor) {
  const card = editor?.closest(".composer-card");
  const tx = card && transcriptOf(card);
  if (!tx || !editor.textContent.trim() || !isPinned(tx)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const bubbles = () => tx.querySelectorAll(".msg-user .b");
  const index = bubbles().length; // the new bubble is the first one past today's
  const from = card.getBoundingClientRect();
  const fromRadius = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
  const ed = editor.getBoundingClientRect();
  const es = getComputedStyle(editor);
  const textFrom = { x: ed.left - from.left, y: ed.top - from.top };

  const ghost = document.createElement("div");
  ghost.className = "msg-user send-flight";
  ghost.setAttribute("aria-hidden", "true");
  const body = document.createElement("div");
  body.className = "b";
  // Same window as the editor: a long draft is scrolled inside max-height.
  const texts = [layer("sf-text sf-from", [...editor.cloneNode(true).childNodes], {
    ...typography(es), width: `${ed.width}px`, height: `${ed.height}px`, overflow: "hidden", color: es.color,
  })];
  const rim = document.createElement("span");
  rim.className = "sf-rim";
  body.append(rim, texts[0]);
  ghost.append(body);

  let target = null;
  let toRadius = fromRadius;
  let textTo = textFrom;
  let padX = 0;
  let start = 0;
  let raf = 0;
  const born = performance.now();

  const place = (rect, radius, p) => {
    ghost.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    body.style.borderRadius = `${radius}px`;
    const shift = `translate(${lerp(textFrom.x, textTo.x, p)}px, ${lerp(textFrom.y, textTo.y, p)}px)`;
    for (const t of texts) t.style.transform = shift;
  };

  const reveal = () => { if (target) target.style.visibility = ""; };
  const finish = () => { cancelAnimationFrame(raf); reveal(); ghost.remove(); };
  const abort = () => {
    cancelAnimationFrame(raf);
    reveal();
    ghost.classList.add("is-gone");
    setTimeout(() => ghost.remove(), FADE_MS);
  };

  // The optimistic bubble is replaced by the durable one mid-flight — same
  // slot, new element — so the target is re-acquired whenever it detaches.
  const acquire = () => {
    reveal();
    target = bubbles()[index] ?? null;
    if (!target) return;
    target.style.visibility = "hidden";
    if (texts.length > 1) return;
    const bs = getComputedStyle(target);
    const padL = parseFloat(bs.paddingLeft);
    padX = padL + parseFloat(bs.paddingRight);
    toRadius = parseFloat(bs.borderTopLeftRadius) || 0;
    textTo = { x: padL, y: parseFloat(bs.paddingTop) };
    texts.push(layer("sf-text sf-to", [...target.cloneNode(true).childNodes], typography(bs)));
    body.append(texts[1]);
  };

  const frame = (now) => {
    if (!target?.isConnected) acquire();
    if (!target) {
      // Lost after take-off: the daemon queued it as a pill instead.
      if (start || now - born > WAIT_MS) return abort();
      raf = requestAnimationFrame(frame);
      return;
    }
    const to = target.getBoundingClientRect();
    if (!to.width) return abort(); // the pane was parked mid-flight
    // Fractional and live: a scrollbar appearing mid-flight narrows the bubble.
    texts[1].style.width = `${to.width - padX}px`;
    if (!start) {
      start = now;
      ghost.classList.add("is-flying");
    }
    const elapsed = now - start;
    if (elapsed >= HANDOFF_MS) return finish();
    const p = flightSpring(elapsed / MOVE_MS);
    place({
      left: lerp(from.left, to.left, p),
      top: lerp(from.top, to.top, p),
      width: lerp(from.width, to.width, p),
      height: lerp(from.height, to.height, p),
    }, lerp(fromRadius, toRadius, p), p);
    raf = requestAnimationFrame(frame);
  };

  place(from, fromRadius, 0);
  document.body.append(ghost);
  texts[0].scrollTop = editor.scrollTop;
  raf = requestAnimationFrame(frame);
}
