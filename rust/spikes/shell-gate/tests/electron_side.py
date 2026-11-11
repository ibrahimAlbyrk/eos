#!/usr/bin/env python3
"""Side-by-side reference: the installed Electron Eos, isolated (own userData, the isolated
daemon), same views, same numbers. Clicks only - never types (it talks to the daemon
directly, with no write guard in between)."""
import json, os, re, subprocess, sys, time, urllib.request
import psutil
from websockets.sync.client import connect
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data"
SHOTS = f"{DATA}/shell-gate-out/shots"; RES = f"{DATA}/shell-gate-out/results"
EXE = "/Applications/Eos.app/Contents/MacOS/Eos"
PORT = 9333
UD = f"{DATA}/shell-gate-out/electron-userdata"
import base64

class Page:
    def __init__(self, ws_url): self.ws = connect(ws_url, max_size=None); self.n = 0
    def call(self, method, **params):
        self.n += 1; self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.n: return m.get("result", m.get("error"))
    def ev(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return (r.get("result") or {}).get("value")
    def click(self, js_el):
        c = self.ev(f"(() => {{ const e = {js_el}; if (!e) return null; e.scrollIntoView({{block:'nearest'}}); const r = e.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; }})()")
        if not c: return False
        for kind, buttons in (("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)):
            self.call("Input.dispatchMouseEvent", type=kind, x=c[0], y=c[1], button="none" if kind == "mouseMoved" else "left", buttons=buttons, clickCount=0 if kind == "mouseMoved" else 1)
        return True
    def shot(self, name, wid=None):
        r = self.call("Page.captureScreenshot", format="png")
        open(f"{SHOTS}/{name}.png", "wb").write(base64.b64decode(r["data"]))
        if wid: subprocess.run(["screencapture", "-x", "-o", "-l", str(wid), f"{SHOTS}/{name}-window.png"])

def target():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=0.5) as r:
            pages = [t for t in json.load(r) if t["type"] == "page" and t["url"].startswith("eos://app")]
            return pages[0]["webSocketDebuggerUrl"] if pages else None
    except OSError: return None

def mem(pid):
    procs = [psutil.Process(pid)] + psutil.Process(pid).children(recursive=True)
    rows = []
    for p in procs:
        try:
            cmd = " ".join(p.cmdline()); m = re.search(r"--type=([a-z-]+)", cmd)
            rows.append({"pid": p.pid, "rssMB": round(p.memory_info().rss / 2**20, 1), "type": m.group(1) if m else "browser(main)"})
        except psutil.Error: pass
    fp = subprocess.run(["footprint", *[str(r["pid"]) for r in rows]], capture_output=True, text=True).stdout
    tot = 0
    for r in rows:
        m = re.search(rf"\[{r['pid']}\].*?Footprint:\s*([\d.]+)\s*(KB|MB|GB)", fp)
        if m: r["footprintMB"] = round(float(m.group(1)) * {"KB": 1/1024, "MB": 1, "GB": 1024}[m.group(2)], 1); tot += r["footprintMB"]
    return {"procs": len(rows), "rssMB": round(sum(r["rssMB"] for r in rows), 1), "footprintMB": round(tot, 1), "rows": rows}

def main():
    assert json.load(urllib.request.urlopen("http://127.0.0.1:7490/health", timeout=2))["ok"], "isolated daemon must be up (else the app would start its own)"
    env = {k: os.environ[k] for k in ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG") if k in os.environ}
    env.update(EOS_HOME=f"{DATA}/run-shell", EOS_PORT="7490", EOS_RAW_PORT="7491", EOS_DAEMON_URL="http://127.0.0.1:7490",
               EOS_RAW_URL="http://127.0.0.1:7491", EOS_ELECTRON_USER_DATA=UD)
    res = {}
    log = open(f"{DATA}/shell-gate-out/electron.log", "ab")
    t0 = time.time()
    proc = subprocess.Popen([EXE, f"--remote-debugging-port={PORT}"], env=env, stdout=log, stderr=log, start_new_session=True)
    try:
        page = None
        while time.time() - t0 < 40:
            ws = target()
            if ws:
                page = page or Page(ws)
                v = page.ev("({side: !!document.querySelector('.side'), origin: performance.timeOrigin, fcp: (performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime ?? null})")
                if v and v["side"]:
                    res["launch"] = {"uiReadyS": round(time.time() - t0, 3), "navStartS": round(v["origin"] / 1000 - t0, 3), "fcpInPageMs": v["fcp"],
                                     "firstPaintS": round((v["origin"] + v["fcp"]) / 1000 - t0, 3) if v["fcp"] else None}
                    break
            time.sleep(0.02)
        print("launch", res.get("launch"))
        time.sleep(2.5)
        wid = subprocess.run(["swift", f"{HERE}/winid.swift", str(proc.pid)], capture_output=True, text=True).stdout.split()
        wid = wid[0] if wid else None
        print("window id", wid)
        page.shot("el-01-home", wid)
        page.click("[...document.querySelectorAll('div.agents-row')].find(e => (e.textContent||'').trim().startsWith('Prod DB Test Users'))"); time.sleep(2.5)
        page.shot("el-02-transcript", wid)
        res["facts"] = page.ev(open(f"{HERE}/facts.js").read())
        time.sleep(4)
        res["dashboardOnly"] = mem(proc.pid); print("dashboard only", {k: res["dashboardOnly"][k] for k in ("procs", "rssMB", "footprintMB")})
        res["latency"] = page.ev("""(async () => { const run = async (url, n) => { const xs = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); const r = await fetch(url); await r.arrayBuffer(); xs.push(performance.now() - t0); } xs.sort((a,b)=>a-b); return { n, mean: +(xs.reduce((a,b)=>a+b,0)/n).toFixed(3), p50: +xs[Math.floor(n/2)].toFixed(3), p95: +xs[Math.floor(n*0.95)].toFixed(3) }; };
            await run(window.__EOS_DAEMON_URL + '/health', 20); return { loopbackHealth: await run(window.__EOS_DAEMON_URL + '/health', 300) }; })()""")
        print("latency", res["latency"])
        page.click("[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Open side panel')"); time.sleep(1.5)
        page.shot("el-04-sidepanel-open", wid)
        page.click("document.querySelector('.sb-settings__account')"); time.sleep(0.6)
        page.click("[...document.querySelectorAll('button, [role=menuitem]')].filter(b => (b.textContent||'').trim().startsWith('Settings')).pop()"); time.sleep(1.5)
        page.shot("el-11-settings", wid)
        page.call("Input.dispatchKeyEvent", type="rawKeyDown", key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27)
        page.call("Input.dispatchKeyEvent", type="keyUp", key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27); time.sleep(0.5)
        # one browser view, created through the daemon's own route (no typing in the UI)
        tab = page.ev("""(async () => { const r = await fetch(window.__EOS_DAEMON_URL + '/browser/tabs?session=w-e5f3ceb6', { method: 'POST', headers: { 'content-type': 'application/json', 'x-eos-ui-token': window.__EOS_UI_TOKEN }, body: JSON.stringify({ url: 'https://example.com' }) }); return { status: r.status, body: await r.json().catch(() => null) }; })()""")
        res["browserTab"] = {"status": tab.get("status"), "keys": sorted((tab.get("body") or {}).keys())}
        time.sleep(7)
        res["withBrowserView"] = mem(proc.pid); print("with one browser view", {k: res["withBrowserView"][k] for k in ("procs", "rssMB", "footprintMB")})
        tab_id = (tab.get("body") or {}).get("tabId")
        if tab_id: page.ev(f"fetch(window.__EOS_DAEMON_URL + '/browser/tabs/{tab_id}?session=w-e5f3ceb6', {{ method: 'DELETE', headers: {{ 'x-eos-ui-token': window.__EOS_UI_TOKEN }} }}).then(r => r.status)")
        time.sleep(0.5)
    finally:
        try: os.killpg(proc.pid, 15)
        except ProcessLookupError: pass
        try: proc.wait(15)
        except subprocess.TimeoutExpired: os.killpg(proc.pid, 9)
    json.dump(res, open(f"{RES}/electron.json", "w"), indent=1)
    print("done; electron stopped")

main()
