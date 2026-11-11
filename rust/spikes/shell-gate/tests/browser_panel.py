#!/usr/bin/env python3
"""Item 3: the real browser panel drives a CEF child view; the daemon's browser verbs
(the ones the browser_* tools call) run through the in-process DevTools channel,
also while the view is hidden or parked.  Needs the app running with a Browser tab open."""
import base64, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from probe import *

OUT = os.environ.get("GATE_RESULTS", "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data/shell-gate-out/results")
os.makedirs(OUT, exist_ok=True)
res = {}

def browser():
    return call("info")["value"]["browser"]

session = ev("performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('/browser/tabs?session=')).pop().split('session=')[1]")
tab = browser()["current"]
print("session", session, "tab", tab)

def rest(path, body=None):
    """The dashboard's own door: page -> in-process handler -> daemon -> browser-host RPC -> CDP."""
    js = f"""(async () => {{ const t0 = performance.now(); const r = await fetch(window.__EOS_DAEMON_URL + {json.dumps(path)} + {json.dumps(('&' if '?' in path else '?') + 'session=' + session)}, {{ method: {json.dumps('POST' if body is not None else 'GET')}, headers: {{'content-type':'application/json','x-eos-ui-token': window.__EOS_UI_TOKEN}}, body: {json.dumps(json.dumps(body)) if body is not None else 'undefined'} }}); let b = null; try {{ b = await r.json() }} catch {{}} return {{ status: r.status, ms: Math.round(performance.now() - t0), body: b }}; }})()"""
    return ev(js)

FORM = "data:text/html," + "<title>gate form</title><h1>Gate form</h1><input id=q aria-label='Query'><button id=go onclick=\"document.getElementById('out').textContent='clicked:'+q.value+':'+event.isTrusted\">Go</button><a href='https://example.com/'>Example link</a><p id=out>idle</p><script>addEventListener('keydown',e=>{window.__keys=(window.__keys||'')+e.key+(e.isTrusted?'!':'?')+' '})</script>"

def verbs(label):
    """navigate, accessibility snapshot, type, click, read back, screenshot."""
    r = {}
    nav = rest(f"/browser/tabs/{tab}/navigate", {"action": "url", "url": FORM})
    r["navigate"] = {"status": nav["status"], "ms": nav["ms"], "error": (nav["body"] or {}).get("error")}
    if nav["status"] != 200:
        d = call("browser", method="navigate", session=session, args=[tab, "url", FORM])
        r["navigateDirect"] = d.get("ok")
    time.sleep(0.7)
    snap = rest(f"/browser/tabs/{tab}/snapshot", {"interactiveOnly": True})
    text = (snap["body"] or {}).get("snapshot", "")
    r["snapshot"] = {"status": snap["status"], "ms": snap["ms"], "text": text}
    refs = {}
    for line in text.splitlines():
        parts = line.strip().split(" ")
        ref = next((p for p in parts if p.startswith("@e")), None)
        if ref: refs[parts[0]] = ref
    r["refs"] = refs
    if "textbox" in refs and "button" in refs:
        t = rest(f"/browser/tabs/{tab}/act", {"ref": refs["textbox"], "text": f"hello {label}"})
        r["type"] = {"status": t["status"], "ms": t["ms"], "error": (t["body"] or {}).get("error")}
        c = rest(f"/browser/tabs/{tab}/act", {"ref": refs["button"], "verb": "click"})
        r["click"] = {"status": c["status"], "ms": c["ms"], "error": (c["body"] or {}).get("error")}
        k = rest(f"/browser/tabs/{tab}/act", {"key": "Tab"})
        r["press"] = {"status": k["status"], "ms": k["ms"]}
        time.sleep(0.2)
        r["pageSaw"] = ev("({out: document.getElementById('out').textContent, keys: window.__keys, vis: document.visibilityState, focus: document.hasFocus(), size: [innerWidth, innerHeight]})", view=tab)
    cap = rest(f"/browser/tabs/{tab}/capture", {"fullPage": False})
    body = cap["body"] or {}
    r["capture"] = {"status": cap["status"], "ms": cap["ms"], "keys": sorted(body.keys()), "error": body.get("error")}
    direct = call("shot", view=tab, file=f"{SHOTS}/tab-{label}.png", timeoutMs=6000)
    r["captureDirect"] = direct.get("value") or direct.get("error")
    return r

# 1. verbs on the visible view
res["visible"] = verbs("visible")
print("visible:", json.dumps({k: v for k, v in res["visible"].items() if k != "snapshot"}))
print(res["visible"]["snapshot"]["text"])

# 2. the splitter moves and resizes the native view
before = browser()
ev("window.__keep = 42", view=tab)
sp = ev("(() => { const r = document.querySelector('.sp-resize').getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; })()")
cdp("Input.dispatchMouseEvent", type="mouseMoved", x=sp[0], y=sp[1], button="none", buttons=0)
cdp("Input.dispatchMouseEvent", type="mousePressed", x=sp[0], y=sp[1], button="left", buttons=1, clickCount=1)
steps = 24
for i in range(1, steps + 1):
    cdp("Input.dispatchMouseEvent", type="mouseMoved", x=sp[0] - i * 10, y=sp[1], button="left", buttons=1)
    time.sleep(0.016)
cdp("Input.dispatchMouseEvent", type="mouseReleased", x=sp[0] - steps * 10, y=sp[1], button="left", buttons=0, clickCount=1)
time.sleep(0.6)
after = browser()
placeholder = ev("(() => { const e = [...document.querySelectorAll('.side-panel *')].filter(e => e.getBoundingClientRect().width > 100 && e.children.length === 0 && e.getBoundingClientRect().height > 300).pop(); return e ? [e.className, Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().top), Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)] : null })()")
res["splitter"] = {"before": before["bounds"], "after": after["bounds"], "geometryCalls": after["geometryCalls"] - before["geometryCalls"],
                   "tabInnerWidth": ev("innerWidth", view=tab), "placeholder": placeholder, "keep": ev("window.__keep", view=tab)}
print("splitter:", json.dumps(res["splitter"]))
shot("t3-06-browser-resized")

# 3. another side-panel tab hides the view without a reload; verbs still work while hidden
def park_and_test(mode):
    call("browser.park", mode=mode)
    click("document.querySelector('.sp-tabbar .sp-plus')")
    time.sleep(0.8)
    st = browser()
    r = {"shown": st["shown"], "visibilityState": ev("document.visibilityState", view=tab), "keep": ev("window.__keep", view=tab)}
    shot(f"t3-07-parked-{mode}")
    r["verbs"] = verbs(f"parked-{mode}")
    r["raf"] = ev("new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 > 500) r(n); else requestAnimationFrame(f) }; requestAnimationFrame(f); setTimeout(() => r(n), 900) })", view=tab)
    # back to the Browser tab
    click("[...document.querySelectorAll('.sp-tabbar .sp-tab-label')].find(e => e.textContent.trim() === 'Browser')")
    time.sleep(0.8)
    r["shownAgain"] = browser()["shown"]
    # close the launcher tab we opened
    return r

ev("window.__keep = 42", view=tab)
for mode in ("hide", "offscreen"):
    res[f"parked-{mode}"] = park_and_test(mode)
    v = res[f"parked-{mode}"]
    print(mode, json.dumps({k: (val if k != "verbs" else {a: b for a, b in val.items() if a != "snapshot"}) for k, val in v.items()}))
call("browser.park", mode="hide")
res["final"] = browser()
json.dump(res, open(f"{OUT}/browser-panel.json", "w"), indent=1)
print("saved")
