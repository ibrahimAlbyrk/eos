#!/usr/bin/env python3
"""Item 4: what a third-party page (https://claude.ai, no sign-in) can see of Tauri in a
stock view and in a no-bridge view; isolated-world shield + binding + zoom still work."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from probe import *
OUT = os.environ.get("GATE_RESULTS", "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data/shell-gate-out/results")
os.makedirs(OUT, exist_ok=True)
URL = os.environ.get("GATE_3P_URL", "https://claude.ai/login")
res = {"url": URL}

SEE = """(async () => { const o = {
  href: location.href, title: document.title, readyState: document.readyState,
  tauriInternals: typeof window.__TAURI_INTERNALS__, tauriGlobal: typeof window.__TAURI__, ipc: typeof window.ipc,
  ipcPostMessage: typeof window.ipc?.postMessage,
  internalsKeys: window.__TAURI_INTERNALS__ ? Object.keys(window.__TAURI_INTERNALS__) : null,
  globalsMatching: Object.getOwnPropertyNames(window).filter(k => /tauri|^ipc$|__eos|eosOverlay/i.test(k)),
  marker: typeof window.__gateInitMarker, csp: !!document.querySelector('meta[http-equiv=Content-Security-Policy]'),
  ua: navigator.userAgent, webdriver: navigator.webdriver };
  if (window.__TAURI_INTERNALS__?.invoke) { try { o.invoke = await Promise.race([window.__TAURI_INTERNALS__.invoke('plugin:app|version'), new Promise(r => setTimeout(() => r('timeout'), 1500))]); } catch (e) { o.invokeError = String(e).slice(0, 200); } }
  return o; })()"""

def open_view(label, no_bridge):
    r = call("view.open", view=label, url=URL, profile=f"gate-{label}", noBridge=no_bridge, stay="claude.ai",
             initScript="window.__gateInitMarker = 1;", x=330, y=70, w=620, h=520)
    wait("document.readyState === 'complete'", 15, view=label)
    time.sleep(1.5)
    return r

# A. stock view (Tauri's defaults)
res["stockOpen"] = open_view("bridged-claude", False)
res["stock"] = ev(SEE, view="bridged-claude")
shot("t3-08-claude-stock")
call("view.set", view="bridged-claude", do="close")

# B. no-bridge view
res["noBridgeOpen"] = open_view("claude", True)
res["noBridge"] = ev(SEE, view="claude")
res["cookieNames"] = call("view.cookies", view="claude", url="https://claude.ai/").get("value")

# isolated world: shield (closed shadow root + constructable stylesheet), binding for the click
SHIELD = """(() => {
  const CSS = ":host{all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;cursor:pointer !important}";
  globalThis.__isoSecret = 'only-in-eosOverlay';
  let shield = null;
  const build = () => { const host = document.createElement('eos-artifact-shield'); const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet];
    host.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (ev.isTrusted) globalThis.eosOverlayAction(ev.altKey ? 'external' : 'open'); });
    host.addEventListener('wheel', (ev) => ev.preventDefault(), { passive: false }); return host; };
  const render = () => { shield ??= build(); if (!shield.isConnected && document.documentElement) document.documentElement.append(shield); };
  const ready = () => { render(); new MutationObserver(render).observe(document.documentElement, { childList: true }); };
  // the peek's half-zoom, as a constructable stylesheet (claude.ai's nonce CSP blocks <style>)
  const zoom = new CSSStyleSheet(); zoom.replaceSync('html{zoom:.5 !important}');
  globalThis.__eosZoom = (on) => { document.adoptedStyleSheets = on ? [...document.adoptedStyleSheets.filter(s => s !== zoom), zoom] : document.adoptedStyleSheets.filter(s => s !== zoom); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();"""
events = []
res["binding"] = cdp("Runtime.addBinding", view="claude", name="eosOverlayAction", executionContextName="eosOverlay").get("ok")
res["addScript"] = cdp("Page.addScriptToEvaluateOnNewDocument", view="claude", worldName="eosOverlay", source=SHIELD).get("ok")
cdp("Runtime.enable", view="claude")
cdp("Page.enable", view="claude")
call("cdp", view="claude", method="Page.reload", params={})
wait("document.readyState === 'complete'", 15, view="claude"); time.sleep(1.5)
res["afterReload"] = ev("({pageSeesSecret: typeof window.__isoSecret, pageSeesBindingFn: typeof window.eosOverlayAction, pageSeesZoomFn: typeof window.__eosZoom, shieldInDom: !!document.querySelector('eos-artifact-shield'), shieldShadow: document.querySelector('eos-artifact-shield')?.shadowRoot ?? 'closed', topElement: document.elementFromPoint(200, 200)?.tagName, ipc: typeof window.ipc, tauri: typeof window.__TAURI_INTERNALS__, innerWidth})", view="claude")
# the isolated context: find it and read the secret there
ctxs = cdp("Runtime.evaluate", view="claude", expression="1")  # warm
iso = call("cdp", view="claude", method="Page.createIsolatedWorld", params={"frameId": cdp("Page.getFrameTree", view="claude")["value"]["frameTree"]["frame"]["id"], "worldName": "eosOverlay"})
ctx_id = (iso.get("value") or {}).get("executionContextId")
res["isoWorld"] = {"contextId": ctx_id is not None,
                   "secret": (cdp("Runtime.evaluate", view="claude", expression="globalThis.__isoSecret", contextId=ctx_id).get("value") or {}).get("result", {}).get("value")}
# zoom 0.5 from the isolated world (CSS), then Chromium zoom (set_zoom)
cdp("Runtime.evaluate", view="claude", expression="globalThis.__eosZoom(true)", contextId=ctx_id)
time.sleep(0.4)
res["zoomCss"] = ev("({innerWidth, clientWidth: document.documentElement.clientWidth, zoom: getComputedStyle(document.documentElement).zoom, dpr: devicePixelRatio})", view="claude")
shot("t3-09-claude-nobridge-zoom-shield")
cdp("Runtime.evaluate", view="claude", expression="globalThis.__eosZoom(false)", contextId=ctx_id)
call("view.set", view="claude", do="zoom", zoom=0.5); time.sleep(0.4)
res["zoomNative"] = ev("({innerWidth, dpr: devicePixelRatio})", view="claude")
call("view.set", view="claude", do="zoom", zoom=1.0)
# a trusted click lands on the shield and comes back through the binding (Rust sees Runtime.bindingCalled)
res["bridgelogBefore"] = None
click_at(200, 200, view="claude"); time.sleep(0.5)
res["shieldClick"] = call("cdp", view="claude", method="Runtime.evaluate", params={"expression": "globalThis.__lastAction ?? null", "contextId": ctx_id}).get("ok")
res["pageNavigatedByClick"] = ev("location.href", view="claude")
res["navlog"] = call("navlog").get("value")
call("view.set", view="claude", do="close")
print(json.dumps(res, indent=1)[:6000])
json.dump(res, open(f"{OUT}/isolation.json", "w"), indent=1)
