// The hover peek of an artifact view. Runs in an
// isolated world of every document the view loads; the page sees none of it. In the peek
// the page is a half-zoom miniature under a shield that turns a click into "open"
// (⌥ → claude.ai) and keeps scrolls and clicks from the page. The site's nonce policy
// blocks inline styles but not constructable stylesheets.
(() => {
  const SHIELD_CSS =
    ":host{all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;cursor:pointer !important}";
  let peek = false;
  let ready = false;
  let shield = null;
  let zoom = null;

  const build = () => {
    const host = document.createElement("eos-artifact-shield");
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHIELD_CSS);
    root.adoptedStyleSheets = [sheet];
    host.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.isTrusted) eosArtifactShield(ev.altKey ? "external" : "open");
    });
    host.addEventListener("wheel", (ev) => ev.preventDefault(), { passive: false });
    return host;
  };

  const render = () => {
    zoom ??= (() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("html{zoom:.5 !important}");
      return sheet;
    })();
    const sheets = document.adoptedStyleSheets;
    if (peek && !sheets.includes(zoom)) document.adoptedStyleSheets = [...sheets, zoom];
    if (!peek && sheets.includes(zoom)) document.adoptedStyleSheets = sheets.filter((s) => s !== zoom);
    if (peek && ready) {
      shield ??= build();
      if (!shield.isConnected && document.documentElement) document.documentElement.append(shield);
    } else {
      shield?.remove();
    }
  };

  // Called by the shell whenever the view becomes the peek or stops being it.
  globalThis.__eosPeek = (on) => {
    peek = on === true;
    render();
  };

  const onReady = () => {
    ready = true;
    render();
    // A page that rebuilds <html>'s children (hydration) takes the shield with it.
    if (document.documentElement) new MutationObserver(render).observe(document.documentElement, { childList: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady, { once: true });
  else onReady();
})();
