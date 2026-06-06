// Theme application — resolves the appearance.theme setting (system/dark/light)
// to a data-theme attribute on <html>. index.html has a matching pre-bundle
// bootstrap reading the same localStorage key so the first paint never flashes.

export const THEME_KEY = "appearance.theme";
export const THEME_STORAGE_KEY = "cm:theme";

export function resolveTheme(setting, prefersLight) {
  if (setting === "dark" || setting === "light") return setting;
  const light = prefersLight ?? window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return light ? "light" : "dark";
}

export function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function apply(resolved) {
  document.documentElement.setAttribute("data-theme", resolved);
  window.webkit?.messageHandlers?.themeChanged?.postMessage(resolved);
}

let fading = false;

export function setTheme(resolved, { animate = false } = {}) {
  if (currentTheme() === resolved) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduced || fading) {
    apply(resolved);
    return;
  }
  // Eos.app: crossfade via a frozen frame — the live page flips underneath an
  // old-theme screenshot that fades out as one unit, so nothing lags behind
  // and backdrop-filter blur never flattens.
  if (window.webkit?.messageHandlers?.themeSnapshot) {
    nativeFade(resolved);
    return;
  }
  if (typeof document.startViewTransition !== "function") {
    apply(resolved);
    return;
  }
  document.startViewTransition(() => apply(resolved)); // default crossfade
}

function nativeFade(resolved) {
  fading = true;
  let fallback;
  const bail = () => {
    clearTimeout(fallback);
    window.__eosThemeSnapshot = null;
    fading = false;
    apply(resolved);
  };
  window.__eosThemeSnapshot = (dataUrl) => {
    clearTimeout(fallback);
    window.__eosThemeSnapshot = null;
    if (!dataUrl) { bail(); return; }
    const img = new Image();
    img.decoding = "sync";
    // decode() before insertion — WebKit rasterizes images async after onload,
    // so an undecoded frame can paint blank for a frame and flash the new
    // theme through. Decoded + painted first (identical pixels, invisible),
    // THEN the theme flips underneath on the next frame.
    const start = () => {
      img.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none;";
      document.body.appendChild(img);
      // WKWebView's takeSnapshot doesn't bake backdrop-filter into pixels, so
      // if the settings modal is open its scrim blur is missing from the
      // frozen frame. Re-apply it live with a layer that blurs everything
      // except the modal box (which must stay sharp, like the real scrim).
      const modal = document.querySelector(".stg-modal");
      let blurDiv = null;
      if (modal) {
        const ov = document.querySelector(".stg-overlay");
        const r = modal.getBoundingClientRect();
        blurDiv = document.createElement("div");
        blurDiv.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
        const bf = ov ? getComputedStyle(ov).webkitBackdropFilter || getComputedStyle(ov).backdropFilter : "blur(8px)";
        blurDiv.style.webkitBackdropFilter = bf;
        blurDiv.style.backdropFilter = bf;
        blurDiv.style.clipPath =
          `path(evenodd, "M0 0H${window.innerWidth}V${window.innerHeight}H0Z ` +
          `M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}Z")`;
        document.body.appendChild(blurDiv);
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        apply(resolved);
        const done = () => { img.remove(); blurDiv?.remove(); fading = false; };
        const els = blurDiv ? [img, blurDiv] : [img];
        const anims = els.map((el) => el.animate({ opacity: [1, 0] }, { duration: 240, easing: "ease-out" }));
        anims[0].onfinish = done;
        anims[0].oncancel = done;
      }));
    };
    img.src = dataUrl;
    if (img.decode) img.decode().then(start, bail);
    else { img.onload = start; img.onerror = bail; }
  };
  fallback = setTimeout(bail, 400); // native never answered → instant
  window.webkit.messageHandlers.themeSnapshot.postMessage(null);
}

export function watchSystemTheme(onChange) {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
