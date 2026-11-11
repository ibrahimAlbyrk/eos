#!/usr/bin/env python3
"""Item 7: cold start to first paint and memory of the whole process tree, with the real
dashboard loaded, without and with one browser view.   usage: measure.py [runs]"""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
G = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DATA = "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data"
OUT = f"{DATA}/shell-gate-out/run"
os.environ["GATE_OUT"] = OUT
from probe import *
APP = os.environ.get("GATE_APP", f"{G}/.work/target/release/bundle/macos/EosShellGate.app")
EXE = f"{APP}/Contents/MacOS/eos-shell-gate"
REPO = os.path.abspath(f"{G}/../../..")

def tree_mem(marker):
    rows = []
    for line in subprocess.run(["ps", "-axo", "pid=,rss=,command="], capture_output=True, text=True).stdout.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and marker in parts[2]:
            kind = "browser(main)"
            m = re.search(r"--type=([a-z-]+)", parts[2]);  kind = m.group(1) if m else kind
            m = re.search(r"--utility-sub-type=([A-Za-z_.]+)", parts[2]); kind = kind + ":" + m.group(1).split(".")[-1] if m else kind
            rows.append({"pid": int(parts[0]), "rssMB": round(int(parts[1]) / 1024, 1), "type": kind})
    fp = subprocess.run(["footprint", *[str(r["pid"]) for r in rows]], capture_output=True, text=True).stdout
    total_fp = 0.0
    for r in rows:
        m = re.search(rf"\[{r['pid']}\].*?Footprint:\s*([\d.]+)\s*(KB|MB|GB)", fp)
        if m:
            v = float(m.group(1)) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)]
            r["footprintMB"] = round(v, 1); total_fp += v
    return {"procs": len(rows), "rssMB": round(sum(r["rssMB"] for r in rows), 1), "footprintMB": round(total_fp, 1), "rows": rows}

def launch():
    for f in os.listdir(f"{OUT}/ctl"): os.remove(f"{OUT}/ctl/{f}")
    if os.path.exists(f"{OUT}/ready"): os.remove(f"{OUT}/ready")
    env = {k: os.environ[k] for k in ("PATH", "HOME", "USER", "TMPDIR", "LANG") if k in os.environ}
    env.update(GATE_OUT=OUT, GATE_UI_DIST=f"{REPO}/app/ui/dist", GATE_API="http://127.0.0.1:7490", GATE_RAW="http://127.0.0.1:7491",
               GATE_TOKEN_FILE=f"{DATA}/run-shell/ui-token", GATE_PROFILE=f"{DATA}/shell-gate-out/profile", GATE_ACCESSORY="1", TAURI_CEF_NO_ACTIVATE="1")
    log = open(f"{OUT}/app.err", "ab")
    t0 = time.time()
    proc = subprocess.Popen([EXE], env=env, stdout=log, stderr=log, start_new_session=True)
    while not os.path.exists(f"{OUT}/ready"):
        if proc.poll() is not None: raise RuntimeError("app exited")
        time.sleep(0.005)
    marks = {"ctlReadyS": round(time.time() - t0, 3)}
    end = time.time() + 20
    while time.time() < end:
        v = ev("({origin: performance.timeOrigin, fcp: (performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime ?? null, ready: window.__eosReadyAt ?? null, nav: performance.getEntriesByType('navigation')[0]?.responseStart ?? null})")
        if isinstance(v, dict) and v.get("ready") and v.get("fcp"):
            marks.update(firstPaintS=round((v["origin"] + v["fcp"]) / 1000 - t0, 3), uiReadyS=round((v["origin"] + v["ready"]) / 1000 - t0, 3),
                         navStartS=round(v["origin"] / 1000 - t0, 3), fcpInPageMs=round(v["fcp"]), readyInPageMs=round(v["ready"]))
            break
        time.sleep(0.01)
    return proc, marks

def panel_open():
    # The tab bar stays in the DOM while the panel is collapsed: only its width tells.
    return ev("(document.querySelector('.sp-tabbar')?.getBoundingClientRect().width ?? 0) > 50") is True

def side_panel(open_):
    if panel_open() != open_:
        click("[...document.querySelectorAll('button')].find(b => /^(Open|Close) side panel$/.test(b.getAttribute('aria-label') || ''))"); time.sleep(0.9)
    return panel_open() == open_

def open_url_in_side_panel(url):
    """Opens `url` through the launcher tab. Types only into the verified URL field."""
    if not side_panel(True): raise SystemExit("side panel did not open")
    if not ev("(document.querySelector('input.nt-field__input')?.getBoundingClientRect().width ?? 0) > 0"):
        click("document.querySelector('.sp-tabbar .sp-plus')"); time.sleep(0.7)
    click("document.querySelector('input.nt-field__input')"); time.sleep(0.3)
    focused = "document.activeElement?.classList.contains('nt-field__input') === true"
    if ev(focused) is not True: raise SystemExit("URL field not focused; refusing to type")
    cdp("Input.insertText", text=url)
    if ev(focused + f" && document.activeElement.value === {json.dumps(url)}") is not True: raise SystemExit("URL field lost focus; refusing to press Enter")
    for t in ("keyDown", "keyUp"):
        cdp("Input.dispatchKeyEvent", type=t, key="Enter", code="Enter", windowsVirtualKeyCode=13, nativeVirtualKeyCode=13, text="\r" if t == "keyDown" else "", unmodifiedText="\r" if t == "keyDown" else "")

def main():
    runs = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    res = {"app": APP, "launches": []}
    for i in range(runs):
        proc, marks = launch()
        print("launch", i, marks)
        res["launches"].append(marks)
        if i == runs - 1:
            # S1: a chat transcript open, side panel closed -> no browser view
            if not ev("!!document.querySelector('.agents-row.is-active, .agents-row[aria-current], .messages-wrap')"):
                click("document.querySelectorAll('div.agents-row')[1]"); time.sleep(1.5)
            side_panel(False)
            # the daemon may still hold browser tabs from an earlier run: drop this app's views
            for tab in call("info")["value"]["browser"]["tabs"]:
                call("browser", method="closeTab", session="", args=[tab])
            time.sleep(6)
            res["dashboardOnly"] = tree_mem(APP); res["dashboardOnly"]["views"] = call("info")["value"]["browser"]["tabs"]
            print("dashboard only:", {k: res["dashboardOnly"][k] for k in ("procs", "rssMB", "footprintMB")})
            # S2: one browser view (example.com) in the side panel
            open_url_in_side_panel("https://example.com")
            time.sleep(7)
            res["withBrowserView"] = tree_mem(APP); res["withBrowserView"]["views"] = call("info")["value"]["browser"]["tabs"]
            print("with one browser view:", {k: res["withBrowserView"][k] for k in ("procs", "rssMB", "footprintMB", "views")})
            shot("t3-10-release-browser")
            if os.environ.get("GATE_KEEP") == "1":
                json.dump(res, open(f"{DATA}/shell-gate-out/results/measure.json", "w"), indent=1); print("kept running"); return
        call("quit"); proc.wait(10); time.sleep(1.5)
    os.makedirs(f"{DATA}/shell-gate-out/results", exist_ok=True)
    json.dump(res, open(f"{DATA}/shell-gate-out/results/measure.json", "w"), indent=1)

main()
