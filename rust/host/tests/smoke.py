#!/usr/bin/env python3
"""Smoke run of the bundled app against the dev proxy. Safe to run again and again.

What it checks:
  1. the app starts once, the dashboard reaches "ready", the storage carry-over ran;
  2. the dashboard's own browser panel puts a child Chromium view on screen;
  3. DevTools round trips work: on a test view through the shell's ports (hidden view
     included), and through the core's browser route for the panel's tab;
  4. the Rust core runs beside the daemon: a route goes to the Rust router when it declares
     it, to the write-refusing proxy otherwise (second launch: the event stream from Rust);
  5. a second launch hands over, `--quit` stops everything.

Rules it keeps (see 08-shell-gate.md §10): it never types into a page and never drives the
dashboard. The dashboard is only told what layout to restore (through the storage
carry-over) and observed through the shell's status; DevTools calls go to views this run
created. The window opens without taking the focus; no page with sound is loaded.

usage: smoke.py <path to Eos.app> [--keep]      --keep leaves the app running at the end
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOST = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The same defaults as scripts/dev-env.sh.
DATA = os.environ.get("EOS_DEV_DATA", "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data")
DEV_HOME = os.environ.get("EOS_DEV_HOME", os.path.join(DATA, "run-shell"))
DEV_OUT = os.environ.get("EOS_DEV_OUT", os.path.join(DATA, "shell-out"))
OUT = os.path.join(DEV_OUT, "smoke")
SHELL_DATA = os.path.join(OUT, "data")
DAEMON = "http://127.0.0.1:" + os.environ.get("EOS_DEV_PORT", "7490")
APP = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else ""
KEEP = "--keep" in sys.argv
BIN = os.path.join(APP, "Contents", "MacOS", "Eos")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'ok  ' if ok else 'FAIL'} {name}{': ' + str(detail) if detail else ''}", flush=True)
    return ok


def ctl(*args, timeout=15):
    env = dict(os.environ, EOS_SHELL_DATA=SHELL_DATA)
    r = subprocess.run([BIN, *args], env=env, capture_output=True, text=True, timeout=timeout)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"running": False, "error": r.stderr.strip()[-200:]}


class Run:
    """What a test run started, and its end: the app and the daemon are stopped whether the
    run finishes, fails, is interrupted or is killed (guard.py covers the last)."""

    def __init__(self, max_seconds=900):
        up = subprocess.run([os.path.join(HOST, "scripts", "daemon.sh"), "status"], capture_output=True, text=True).stdout.strip() == "up"
        self.started_daemon = not up
        self.guard = subprocess.Popen(
            [sys.executable, os.path.join(HOST, "tests", "guard.py"), str(os.getpid()), APP, SHELL_DATA, "1" if self.started_daemon else "0", str(max_seconds)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        # An interrupt or a polite kill ends the run through `finally`.
        for sig in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, lambda *_: sys.exit(130))
        subprocess.run([os.path.join(HOST, "scripts", "daemon.sh"), "start"], check=True, capture_output=True)

    def stop_app(self):
        """Quits the app this run launched and waits for its processes to go."""
        pid = ctl("--status").get("pid")
        if not pid:
            return True
        ctl("--quit")
        gone = wait_for("exit", lambda: not alive(pid), 15)
        wait_for("helpers", lambda: not helpers(), 10)
        return gone

    def close(self, keep=False):
        """`keep`: leave the app and the daemon running for a person to look at."""
        try:
            if not keep:
                self.stop_app()
                if self.started_daemon:
                    subprocess.run([os.path.join(HOST, "scripts", "daemon.sh"), "stop"], capture_output=True, timeout=30)
        finally:
            self.guard.terminate()  # our own child: it has nothing left to watch


def helpers():
    """Pids of processes still running from the bundle's helper apps (looked at, never signalled)."""
    return subprocess.run(["pgrep", "-f", os.path.join(APP, "Contents", "Frameworks")], capture_output=True, text=True).stdout.split()


def wait_for(what, predicate, seconds):
    end = time.time() + seconds
    last = None
    while time.time() < end:
        last = predicate()
        if last:
            return last
        time.sleep(0.25)
    return None


def token():
    with open(os.path.join(DEV_HOME, "ui-token")) as f:
        return f.read().strip()


def daemon(path, body=None, method=None):
    """A request to the isolated daemon as the dashboard would make it. The token is read
    from the daemon's own home and never printed."""
    req = urllib.request.Request(DAEMON + path, method=method or ("POST" if body is not None else "GET"))
    req.add_header("x-eos-ui-token", token())
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def main():
    if not os.path.isfile(BIN):
        print(__doc__)
        return 2
    if ctl("--status").get("running"):
        print("an app is already running on the smoke data folder; quit it first (ctl.sh --quit)")
        return 2
    run = Run()
    try:
        return checks(run)
    finally:
        run.close(keep=KEEP)


def checks(run):
    # ---- a fresh shell profile, and an "Electron profile" holding the layout to restore:
    # one chat selected with the Browser tab open in its side panel.
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)
    status, workers = daemon("/workers")
    roots = [w for w in (workers or []) if isinstance(w, dict) and not w.get("parent_id") and not w.get("archived_at")] if status == 200 else []
    if not check("the isolated daemon lists chats", roots, f"{len(roots)} top-level"):
        return 1
    chat = roots[0]["id"]
    layout = {
        "cm:selectedId": chat,
        "cm:paneTree": json.dumps({"t": "leaf", "id": "p1_smoke", "agentId": chat}),
        "cm:paneFocusedLeaf": "p1_smoke",
        "cm:sidePanels": json.dumps({"p1_smoke": {"open": True, "openTabs": ["browser"], "activeTab": "browser", "tabHistory": ["browser"], "windowWidth": None}}),
        "cm:sideCollapsed": "0",
        "smoke:non-ascii": "ğüşiöç — ✓ 😀",
    }
    seed_json = os.path.join(OUT, "layout.json")
    with open(seed_json, "w") as f:
        json.dump(layout, f)
    electron = os.path.join(OUT, "electron-profile")
    seeded = subprocess.run(
        ["bash", "-c", f'source "{HOST}/scripts/env.sh" && cargo run -q --manifest-path "{HOST}/../Cargo.toml" -p eos-bridge --example seed_local_storage -- "{electron}" "{seed_json}"'],
        capture_output=True, text=True)
    if not check("an Electron profile was prepared", seeded.returncode == 0, seeded.stdout.strip() or seeded.stderr.strip()[-300:]):
        return 1

    # ---- steps on a test view of our own, through the shell's ports.
    shot = os.path.join(OUT, "test-view.png")
    dashboard_shot = os.path.join(OUT, "dashboard.png")
    page = "data:text/html,<title>smoke</title><body style='background:%23246'><h1 id=h>smoke view</h1>"
    panel_page = "data:text/html,<title>Panel</title><h1>Panel page</h1><button>Go</button>"
    steps = [
        {"create": {"as": "t", "profile": "smoke", "url": page}},
        {"wait": 600},
        {"cdp": {"view": "t", "method": "Runtime.evaluate", "params": {"expression": "document.getElementById('h').textContent + ':' + (6*7)", "returnByValue": True}}},
        {"cdp": {"view": "t", "method": "Runtime.evaluate", "params": {"expression": "({ipc: typeof window.ipc, tauri: typeof window.__TAURI_INTERNALS__, eos: typeof window.__EOS_UI_TOKEN, vis: document.visibilityState})", "returnByValue": True}}},
        {"capture": {"view": "t", "file": shot}},
        {"place": {"view": "t", "rect": [40, 80, 320, 200]}},
        {"wait": 300},
        {"park": "t"},
        {"cdp": {"view": "t", "method": "Runtime.evaluate", "params": {"expression": "1+1", "returnByValue": True}}},
        {"close": "t"},
        {"wait": 2500},
        {"capture": {"view": None, "file": dashboard_shot}},
        # 12-14: the tab the dashboard opened for the selected chat, driven as the user's window.
        {"browser": {"method": "GET", "path": f"/browser/tabs?session={chat}", "tab": "p", "retry_ms": 30000}},
        {"browser": {"method": "POST", "path": "/browser/tabs/{p}/navigate?session=" + chat, "body": {"action": "url", "url": panel_page}}},
        {"browser": {"method": "POST", "path": "/browser/tabs/{p}/snapshot?session=" + chat, "body": {"interactiveOnly": False}}},
    ]
    steps_file, steps_out = os.path.join(OUT, "steps.json"), os.path.join(OUT, "steps-out.json")
    with open(steps_file, "w") as f:
        json.dump(steps, f)

    env = dict(os.environ, EOS_DEV_DATA=DATA, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE=electron,
               EOS_DEV_SCRIPT=steps_file, EOS_DEV_SCRIPT_OUT=steps_out)
    started = time.time()
    subprocess.run([os.path.join(HOST, "scripts", "launch.sh"), APP, "--quiet"], check=True, env=env)

    # ---- 1. ready
    st = wait_for("ready", lambda: (lambda s: s if bridge_of(s).get("ready") else None)(ctl("--status")), 40)
    if not check("the dashboard reached ready", st, f"{time.time() - started:.1f} s after launch" if st else "not within 40 s"):
        return finish(1)
    b = st["bridge"]
    check("ready soon after the first page", b["readyInPageMs"] < 15000, f"{b['readyInPageMs']} ms in the page")
    check("one event stream from the dashboard", b["eventStreams"] == 1, b["eventStreams"])
    check("the window did not take the focus", st["window"]["focused"] is False, st["window"])
    check("the app menu is installed", st.get("menus") == ["Eos", "Edit", "View", "Machines", "Window"], st.get("menus"))
    marker = os.path.join(SHELL_DATA, "migrated-from-electron.json")
    done = wait_for("marker", lambda: os.path.exists(marker), 10)
    check("the storage carry-over ran once", done, json.load(open(marker)) if done else "no marker")

    # ---- 3a. the test view, through the ports
    out = wait_for("steps", lambda: (lambda o: o if o and o.get("done") else None)(read_json(steps_out)), 90)
    if check("the scripted steps finished", out, "" if out else "not within 90 s"):
        r = out["results"]
        check("every step succeeded", all(x["ok"] for x in r), [x.get("error") for x in r if not x["ok"]])
        check("a DevTools round trip on a test view", r[2].get("value", {}).get("result", {}).get("value") == "smoke view:42", f"{r[2].get('ms')} ms")
        seen = r[3].get("value", {}).get("result", {}).get("value", {})
        check("the test view has no bridge of any kind", seen.get("ipc") == "undefined" and seen.get("tauri") == "undefined" and seen.get("eos") == "undefined", seen)
        check("a parked view can be captured", r[4].get("ok") and os.path.getsize(shot) > 1000, f"{os.path.getsize(shot) if os.path.exists(shot) else 0} bytes")
        check("a parked view still answers", r[8].get("value", {}).get("result", {}).get("value") == 2)
        check("the dashboard was captured", r[11].get("ok") and os.path.exists(dashboard_shot), "kept in the private output folder")

    # ---- 2. the dashboard's own browser panel. The restored layout has the Browser tab
    # open, so the dashboard opens a tab by itself (a child view) and reports it as active.
    # A blank tab shows the dashboard's own placeholder; the view comes on screen once the
    # tab has a page, so the script navigated it the way the dashboard's address bar would:
    # through the core's browser route, not by typing.
    if out:
        tabs, navigated, snap = ((step.get("value") or {}) for step in r[12:15])
        tab = ((tabs.get("body") or {}).get("tabs") or [{}])[0].get("tabId")
        check("the dashboard opened a browser tab: a child view", tab, "" if tab else "not within 30 s")
        check("the tab was navigated through the core's browser route", navigated.get("status") == 200, navigated.get("status"))
        text = (snap.get("body") or {}).get("snapshot", "")
        check("a DevTools round trip through the browser route", snap.get("status") == 200 and "@e1" in text and "Panel page" in text, f"{r[14].get('ms')} ms")
        st = wait_for("panel", lambda: (lambda s: s if bridge_of(s).get("panel", {}).get("shown") else None)(ctl("--status")), 30)
        if check("the browser panel's view is on screen", st, "" if st else "not within 30 s"):
            panel = bridge_of(st)["panel"]
            view = next((v for v in st["views"] if v["id"] == panel["view"]), None)
            check("placed at the panel's rectangle by the dashboard", view and view["placed"] and panel["bounds"][2] > 100 and panel["bounds"][3] > 100, panel["bounds"])
            check("the panel is the selected chat's", panel["view"] == tab and panel["session"] == chat)
        core = bridge_of(ctl("--status")).get("core") or {}
        check("the browser routes are the Rust core's", any(route.startswith("POST /browser/") for route in core.get("rustRoutes") or []))

    # ---- 4. the write guard: the dashboard itself already tried a write on startup.
    st = ctl("--status")
    log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("the app is still up and answering", st.get("running") and bridge_of(st).get("requests", {}).get("core", 0) > 10, bridge_of(st).get("requests"))
    core = bridge_of(st).get("core") or {}
    check("the Rust core runs and the daemon answers what it does not declare", isinstance(core.get("rust"), int) and core.get("proxy", 0) > 10,
          {k: core.get(k) for k in ("rust", "proxy", "proxyRefusedWrites", "rustRoutes", "heldBack")})
    check("nothing failed in the shell's log", "failed" not in log and "could not" not in log and "panic" not in log)

    # ---- 5. single instance, then quit
    again = subprocess.run([BIN], env=dict(os.environ, EOS_SHELL_DATA=SHELL_DATA, EOS_SHELL_QUIET="1"), capture_output=True, text=True, timeout=15)
    check("a second launch hands over and exits", again.returncode == 0 and '"ok":true' in again.stdout, again.stdout.strip()[:60])
    link = subprocess.run([BIN, "eos://pair/smoke-not-a-real-invite"], env=dict(os.environ, EOS_SHELL_DATA=SHELL_DATA), capture_output=True, text=True, timeout=15)
    time.sleep(0.3)
    log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("a link is handed to the running app, and never logged", link.returncode == 0 and "a link was opened with the app" in log and "smoke-not-a-real-invite" not in log)
    pid = st.get("pid")
    return finish(0, pid)


def bridge_of(status):
    """The bridge's part of the status; empty until the shell has built it."""
    return status.get("bridge") or {}


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError):
        return False


def finish(code, pid=None):
    if not KEEP:
        pid = pid or ctl("--status").get("pid")
        ctl("--quit")
        gone = wait_for("exit", lambda: not alive(pid), 15) if pid else True
        check("--quit stopped the app", gone, f"pid {pid}")
        at_quit = helpers()
        left = wait_for("helpers", lambda: not helpers(), 10)
        check("no helper process is left", left, f"{len(at_quit)} at quit")
        check("no app answers after quit", ctl("--status").get("running") is False)
        frame = read_json(os.path.join(SHELL_DATA, "window.json")) or {}
        check("the window's frame was kept for the next launch", frame.get("width", 0) >= 800 and frame.get("height", 0) >= 500, {k: frame.get(k) for k in ("width", "height")})
        log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read() if os.path.exists(os.path.join(SHELL_DATA, "logs", "shell.log")) else ""
        check("quitting ran the shutdown path once", log.count("shell: quitting") == 1)
        if code == 0:
            rust_stream()
    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else code


def rust_stream():
    """A second, short launch with the event stream served by the Rust router: a request that
    stays open, through the real mapping, in the bundled app."""
    env = dict(os.environ, EOS_DEV_DATA=DATA, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none", EOS_DEV_RUST_STREAM="1")
    subprocess.run([os.path.join(HOST, "scripts", "launch.sh"), APP, "--quiet"], check=True, env=env)
    st = wait_for("ready", lambda: (lambda s: s if bridge_of(s).get("ready") else None)(ctl("--status")), 40)
    served = wait_for("stream", lambda: (lambda c: c if "GET /stream" in (c.get("rustRoutes") or []) else None)(bridge_of(ctl("--status")).get("core") or {}), 15) if st else None
    check("the Rust router serves the event stream when asked to", served, {k: served.get(k) for k in ("rust", "proxy", "rustRoutes")} if served else "not served by Rust")
    opened = ctl("--status").get("transport", {})
    pid = ctl("--status").get("pid")
    ctl("--quit")
    check("the app with an open Rust stream quits cleanly", pid and wait_for("exit", lambda: not alive(pid), 15), f"{opened.get('opened')} requests")


if __name__ == "__main__":
    sys.exit(main())
