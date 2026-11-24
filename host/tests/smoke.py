#!/usr/bin/env python3
"""Smoke run of the test bundle (scripts/bundle.sh test) on private test data. Safe to run
again and again.

What it checks:
  0. a `--background` start keeps the window hidden and the dashboard unloaded, until a
     plain launch shows it;
  1. the app starts once, shown, the dashboard reaches "ready", the storage carry-over ran;
  2. the dashboard's own browser panel puts a child Chromium view on screen;
  3. DevTools round trips work: on a test view through the shell's ports (hidden view
     included), and through the core's browser route for the panel's tab;
  4. the Rust core answers every request behind the dev guard, the event stream included;
  5. a second launch hands over, `--quit` stops everything;
  6. the logs: both files beside this run's data, the story told, nothing private in them;
  7. a number set on the Dock icon is what the icon shows;
  8. a window kept hidden releases the dashboard's view (after a shortened time), keeps the
     other child views, and showing it again makes the view again;
  9. the menu-bar item shows only once a routine exists (the data copy has none; a copy
     with one is made for it), follows the working runs live, and `--quit` with runs working
     quits without asking;
 10. an `eos-dev://send` link opens the quick panel without activating the app, a file opened
     with the app is held for it, and no global shortcut is registered.
Also, without running it: the bundle's contents, the screen saver included (never installed
or started), and the Eos menu's screen-saver items.

Rules it keeps (see 08-shell-gate.md §10): it never types into a page and never drives the
dashboard. The dashboard is only told what layout to restore (through the storage
carry-over) and observed through the shell's status; DevTools calls go to views this run
created. The window opens without taking the focus; no page with sound is loaded.

usage: smoke.py <path to Eos.app> [--keep]      --keep leaves the app running at the end
"""
import json
import os
import plistlib
import re
import signal
import sqlite3
import subprocess
import sys
import time

HOST = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The same defaults as scripts/dev-env.sh.
DATA = os.environ.get("EOS_DEV_DATA", "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data")
DEV_HOME = os.environ.get("EOS_DEV_HOME", os.path.join(DATA, "run-shell"))
DEV_OUT = os.environ.get("EOS_DEV_OUT", os.path.join(DATA, "shell-out"))
OUT = os.path.join(DEV_OUT, "smoke")
SHELL_DATA = os.path.join(OUT, "data")
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
    """What a test run started, and its end: the app is stopped whether the run finishes,
    fails, is interrupted or is killed (guard.py covers the last)."""

    def __init__(self, max_seconds=900):
        self.guard = subprocess.Popen(
            [sys.executable, os.path.join(HOST, "tests", "guard.py"), str(os.getpid()), APP, SHELL_DATA, str(max_seconds)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        # An interrupt or a polite kill ends the run through `finally`.
        for sig in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, lambda *_: sys.exit(130))

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
        """`keep`: leave the app running for a person to look at."""
        try:
            if not keep:
                self.stop_app()
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


def chats():
    """The data copy's top-level chats that are not archived, newest first (as the sidebar
    lists them): `{"id", "name"}` each. Read from its state.db without writing to it, before
    the app runs; from the folder it is copied from while the copy is not made yet."""
    db = next((d for d in (os.path.join(DEV_HOME, "state.db"), os.path.join(DATA, "home", "state.db")) if os.path.isfile(d)), None)
    if not db:
        return []
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT id, name FROM workers WHERE parent_id IS NULL AND archived_at IS NULL ORDER BY started_at DESC").fetchall()
    finally:
        conn.close()
    return [{"id": id, "name": name} for id, name in rows]


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


def bundle_contents():
    """What the bundle must ship beside the program; the location helper is never run."""
    res = os.path.join(APP, "Contents", "Resources")
    plist = open(os.path.join(APP, "Contents", "Info.plist")).read()
    helper = os.path.join(res, "EosLocation.app", "Contents")
    helper_plist = open(os.path.join(helper, "Info.plist")).read() if os.path.isfile(os.path.join(helper, "Info.plist")) else ""
    check("the bundle ships esbuild, the plugin skill, pdf.js and the update applier",
          os.access(os.path.join(res, "esbuild"), os.X_OK) and os.path.isfile(os.path.join(res, "claude-plugin", "skills", "eos-plugin-authoring", "SKILL.md"))
          and os.path.isdir(os.path.join(res, "pdfjs")) and os.access(os.path.join(APP, "Contents", "MacOS", "eos-apply"), os.X_OK))
    check("the location helper is a bundle of its own, named after the app",
          os.access(os.path.join(helper, "MacOS", "eos-location"), os.X_OK) and "<string>eos-location</string>" in helper_plist
          and ".location</string>" in helper_plist and "NSLocationUsageDescription" in helper_plist)
    check("the app says why it may use the local network", "NSLocalNetworkUsageDescription" in plist)
    check("the app says why it may drive Mail", "NSAppleEventsUsageDescription" in plist)
    screen_saver(os.path.join(res, "Eos.saver"))


def screen_saver(saver):
    """The screen saver the app menu installs: a well-formed, signed loadable bundle. Never
    installed or started here."""
    contents = os.path.join(saver, "Contents")
    try:
        with open(os.path.join(contents, "Info.plist"), "rb") as f:
            info = plistlib.load(f)
    except (OSError, plistlib.InvalidFileException) as e:
        check("the bundle ships the screen saver", False, e)
        return
    exe = os.path.join(contents, "MacOS", info.get("CFBundleExecutable", ""))
    kind = subprocess.run(["/usr/bin/file", "-b", exe], capture_output=True, text=True).stdout.strip()
    symbols = subprocess.run(["/usr/bin/nm", "-U", exe], capture_output=True, text=True).stdout
    principal = info.get("NSPrincipalClass", "")
    check("the screen saver is a loadable bundle with its principal class",
          info.get("CFBundlePackageType") == "BNDL" and info.get("CFBundleName") == "Eos" and principal == "EosSaverView"
          and kind == "Mach-O 64-bit bundle arm64" and f"_OBJC_CLASS_$_{principal}" in symbols, kind)
    resources = os.path.join(contents, "Resources")
    shipped = ["FirstLight.metal", "thumbnail.png", "thumbnail@2x.png", "Geist.woff2", "IBMPlexMono.woff2"]
    missing = [f for f in shipped if not os.path.isfile(os.path.join(resources, f))]
    check("the screen saver ships its shader, thumbnails and clock faces", not missing, missing)
    signed = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", saver], capture_output=True, text=True)
    check("the screen saver is signed", signed.returncode == 0, signed.stderr.strip()[-200:])


def hidden_start(run):
    """0. A `--background` start, on a shell data folder thrown away afterwards."""
    env = dict(os.environ, EOS_DEV_DATA=DATA, EOS_SHELL_DATA=SHELL_DATA)
    subprocess.run([os.path.join(HOST, "scripts", "launch.sh"), APP, "--quiet", "--background"], check=True, env=env)
    st = wait_for("bridge", lambda: (lambda s: s if s.get("bridge") else None)(ctl("--status")), 40)
    if not check("a --background start comes up", st, "" if st else "not within 40 s"):
        return
    time.sleep(3)
    log = lambda: open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    st = ctl("--status")
    check("a --background start keeps the window hidden", st["window"]["visible"] is False, st["window"])
    check("... and loads no dashboard", "dashboard view opened" not in log() and not bridge_of(st).get("ready"))
    check("... and knows why", "launch kind Background, window hidden" in log())
    again = ctl("--background")
    time.sleep(1)
    check("a later --background launch answers and shows nothing", again.get("ok") is True and ctl("--status")["window"]["visible"] is False, again)
    shown = ctl()
    st = wait_for("ready", lambda: (lambda s: s if bridge_of(s).get("ready") else None)(ctl("--status")), 40)
    check("a plain launch then shows the window and loads the dashboard",
          shown.get("ok") is True and st and st["window"]["visible"] is True and "dashboard view opened" in log(),
          st["window"] if st else "not ready within 40 s")
    check("--quit stops the hidden start", run.stop_app())


def released(run):
    """8. The dashboard's view released while the window stays hidden, on a shell data folder
    thrown away afterwards. The release time is shortened to a few seconds."""
    subprocess.run(["rm", "-rf", SHELL_DATA], check=True)
    os.makedirs(SHELL_DATA)
    steps_file, steps_out = os.path.join(OUT, "release-steps.jsonl"), os.path.join(OUT, "release-out.jsonl")
    page = "data:text/html,<title>kept</title><h1>kept view</h1>"
    with open(steps_file, "w") as f:
        f.write(json.dumps({"create": {"as": "k", "profile": "smoke", "url": page}}) + "\n")
    env = dict(os.environ, EOS_DEV_DATA=DATA, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none",
               EOS_DEV_SCRIPT=steps_file, EOS_DEV_SCRIPT_OUT=steps_out, EOS_DEV_SCRIPT_FOLLOW="1",
               EOS_DEV_DASHBOARD_RELEASE_MS="3000")
    subprocess.run([os.path.join(HOST, "scripts", "launch.sh"), APP, "--quiet"], check=True, env=env)
    st = wait_for("ready", lambda: (lambda s: s if bridge_of(s).get("ready") else None)(ctl("--status")), 40)
    if not check("a plain start reports the dashboard loaded", st and st.get("dashboard") == "loaded", st and st.get("dashboard")):
        return run.stop_app()
    kept = wait_for("kept view", lambda: ctl("--status").get("views"), 20)
    # The item's first reads are done well before the view is released.
    check("no menu-bar item while no routine exists", ctl("--status").get("tray") is None)
    with open(steps_file, "a") as f:
        f.write(json.dumps({"hide": None}) + "\n")
    st = wait_for("released", lambda: (lambda s: s if s.get("dashboard") == "released" else None)(ctl("--status")), 30)
    log = lambda: open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("a window kept hidden releases the dashboard's view", st and st["window"]["visible"] is False and "views: dashboard view closed" in log(),
          st["window"] if st else "not within 30 s")
    check("... and keeps the other child views", kept and st and st.get("views") == kept, st and st.get("views"))
    shown = ctl()
    st = wait_for("loaded", lambda: (lambda s: s if s.get("dashboard") == "loaded" and s["window"]["visible"] else None)(ctl("--status")), 30)
    reloaded = wait_for("reloaded", lambda: log().count("shell: dashboard loading") == 2, 30)
    check("showing the window makes the dashboard's view again and loads the page",
          shown.get("ok") is True and st and reloaded and log().count("in-process handler registered") == 2,
          st.get("dashboard") if st else "not within 30 s")
    with open(steps_file, "a") as f:
        f.write(json.dumps({"end": None}) + "\n")
    check("--quit stops the released run", run.stop_app())


def arm(home, count):
    """A private copy of the data folder at `home` with `count` routines armed
    (crates/eos-app/examples/arm_routines.rs, on a scripted engine)."""
    if not os.path.isdir(home):
        subprocess.run(["cp", "-R", os.path.join(DATA, "home"), home], check=True)
        subprocess.run(["chmod", "-R", "go-rwx", home], check=True)
    made = subprocess.run(["cargo", "run", "-q", "-p", "eos-app", "--example", "arm_routines", "--", home, str(count)],
                          cwd=os.path.dirname(HOST), capture_output=True, text=True)
    if made.returncode != 0:
        raise SystemExit("the routines were not armed: " + made.stderr.strip()[-300:])


def menu_bar(run):
    """9. The menu-bar item and quitting with runs working, on a data copy with one routine
    and a shell data folder, both thrown away afterwards."""
    subprocess.run(["rm", "-rf", SHELL_DATA], check=True)
    os.makedirs(SHELL_DATA)
    home = os.path.join(OUT, "menu-home")
    subprocess.run(["rm", "-rf", home], check=True)
    arm(home, 1)
    steps_file, steps_out = os.path.join(OUT, "menu-steps.jsonl"), os.path.join(OUT, "menu-out.jsonl")

    def step(value):
        with open(steps_file, "a") as f:
            f.write(json.dumps(value) + "\n")

    open(steps_file, "w").close()
    env = dict(os.environ, EOS_DEV_DATA=DATA, EOS_DEV_HOME=home, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none",
               EOS_DEV_SCRIPT=steps_file, EOS_DEV_SCRIPT_OUT=steps_out, EOS_DEV_SCRIPT_FOLLOW="1")
    subprocess.run([os.path.join(HOST, "scripts", "launch.sh"), APP, "--quiet"], check=True, env=env)
    try:
        st = wait_for("ready", lambda: (lambda s: s if bridge_of(s).get("ready") else None)(ctl("--status")), 40)
        if not check("the menu-bar run comes up", st, "" if st else "not within 40 s"):
            return
        tray = lambda: ctl("--status").get("tray")
        shown = wait_for("item", tray, 15)
        items = (shown or {}).get("items") or []
        check("the menu-bar item shows once a routine exists, its icon in the menu bar",
              shown and (shown.get("rect") or [0, 0, 0])[2] > 0 and items[:2] == ["Eos (dev)", "Nothing running"]
              and "Stop all routines" in items and items[-1] == "Quit Eos", shown)
        step({"runs": 2})
        working = wait_for("working", lambda: (lambda t: t if t and "2 runs working" in t["items"] else None)(tray()), 10)
        check("... and counts the runs working", working, tray())
        pid = ctl("--status").get("pid")
        quit = ctl("--quit")
        gone = wait_for("exit", lambda: not alive(pid), 15)
        log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
        check("--quit with runs working quits without asking",
              quit.get("ok") is True and gone and "quit asked" not in log, quit)
        wait_for("helpers", lambda: not helpers(), 10)
    finally:
        run.stop_app()
        subprocess.run(["rm", "-rf", home], check=True)


def checks(run):
    bundle_contents()
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)
    hidden_start(run)
    released(run)
    menu_bar(run)
    # ---- a fresh shell profile, and an "Electron profile" holding the layout to restore:
    # one chat selected with the Browser tab open in its side panel.
    subprocess.run(["rm", "-rf", SHELL_DATA], check=True)
    os.makedirs(SHELL_DATA)
    roots = chats()
    if not check("the data copy holds chats", roots, f"{len(roots)} top-level"):
        return 1
    chat = roots[0]["id"]
    layout = {
        "cm:selectedId": chat,
        "cm:paneTree": json.dumps({"t": "leaf", "id": "p1_smoke", "agentId": chat}),
        "cm:paneFocusedLeaf": "p1_smoke",
        "cm:sidePanels": json.dumps({"p1_smoke": {"open": True, "openTabs": ["browser"], "activeTab": "browser", "tabHistory": ["browser"], "windowWidth": None}}),
        "cm:activeView": "agents",
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
        {"badge": 3},
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
    check("a plain start shows the window", st["window"]["visible"] is True, st["window"])
    check("the window did not take the focus", st["window"]["focused"] is False, st["window"])
    check("the app menu is installed", st.get("menus") == ["Eos", "Edit", "View", "Machines", "Window", "Help"], st.get("menus"))
    check("the Help menu reveals the logs", "Reveal Logs" in (st.get("helpMenu") or []), st.get("helpMenu"))
    window_menu = st.get("windowMenu") or []
    check("the Window menu is the Electron app's, without a Close Window that would take ⌘W from the dashboard",
          window_menu[:2] == ["Minimize", "Zoom"] and "Bring All to Front" in window_menu
          and not any("Close" in item for item in window_menu), window_menu)
    logs = os.path.join(SHELL_DATA, "logs")
    check("the logs are beside this run's data, and --status says so",
          (st.get("logs") or {}).get("folder") == logs and os.path.isdir(logs), (st.get("logs") or {}).get("folder"))
    app_menu = st.get("appMenu") or []
    check("the app menu offers the screen saver", "Lock Screen" in app_menu and "Install Screen Saver…" in app_menu, app_menu)
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
        check("the Dock icon shows the number set on it", r[15].get("ok") and ctl("--status").get("dockBadge") == "3", ctl("--status").get("dockBadge"))

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
        check("the browser routes are the Rust core's", any(route.startswith("POST /browser/") for route in core.get("routes") or []))

    # ---- 4. the Rust core behind the dev guard.
    st = ctl("--status")
    log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("the app is still up and answering", st.get("running") and bridge_of(st).get("requests", {}).get("core", 0) > 10, bridge_of(st).get("requests"))
    core = bridge_of(st).get("core") or {}
    check("the Rust core answers behind the dev guard, agents refused", core.get("rust", 0) > 10 and core.get("agentsAllowed") is False,
          {k: core.get(k) for k in ("rust", "refused", "agentsAllowed")})
    check("the dashboard's event stream is the Rust core's", "GET /stream" in (core.get("routes") or []))
    check("nothing failed in the shell's log", "failed" not in log and "could not" not in log and "panic" not in log)

    # ---- 5. single instance, then quit
    again = subprocess.run([BIN], env=dict(os.environ, EOS_SHELL_DATA=SHELL_DATA, EOS_SHELL_QUIET="1"), capture_output=True, text=True, timeout=15)
    check("a second launch hands over and exits", again.returncode == 0 and '"ok":true' in again.stdout, again.stdout.strip()[:60])
    link = subprocess.run([BIN, "eos://pair/smoke-not-a-real-invite"], env=dict(os.environ, EOS_SHELL_DATA=SHELL_DATA), capture_output=True, text=True, timeout=15)
    time.sleep(0.3)
    log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("a link is handed to the running app, and never logged", link.returncode == 0 and "a link was opened with the app" in log and "smoke-not-a-real-invite" not in log)
    quick_panel(link_env=dict(os.environ, EOS_SHELL_DATA=SHELL_DATA))
    pid = st.get("pid")
    return finish(0, pid)


def quick_panel(link_env):
    """The door step: an `eos-dev://send` link holds its text and opens the quick panel, a
    non-activating panel that never makes Eos the active app. A quiet run never gives it the
    keyboard, so the panel's taking the keyboard is left to the installed app's check."""
    sent = subprocess.run([BIN, "eos-dev://send?text=smoke+door+text"], env=link_env, capture_output=True, text=True, timeout=15)
    st = wait_for("quick panel", lambda: (lambda s: s if (s.get("quick") or {}).get("visible") else None)(ctl("--status")), 20)
    if not check("a send link opens the quick panel", sent.returncode == 0 and st, (st or {}).get("quick")):
        return
    quick = st["quick"]
    check("the panel is a non-activating panel", quick.get("panel") and quick.get("nonactivating"), quick)
    check("the panel did not make Eos the active app", quick.get("appActive") is False, quick)
    streams = wait_for("quick stream", lambda: bridge_of(ctl("--status")).get("quickStreams"), 20)
    check("the panel's page listens on its own event stream", streams == 1, streams)
    log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("the held text is never logged", "smoke door text" not in log and "smoke+door" not in log)
    check("a test run registers no global shortcut", "shortcut" in st and st["shortcut"] is None, st.get("shortcut"))
    # A file opened with the app (as a Dock drop is) is held for the panel, never logged.
    dropped = os.path.join(OUT, "smoke-dropped-report.txt")
    with open(dropped, "w") as f:
        f.write("a build log\n")
    subprocess.run(["open", "-g", "-a", APP, dropped], env=link_env, check=False, timeout=15)
    core_log = os.path.join(SHELL_DATA, "logs", "core.log")
    held = wait_for("dock item", lambda: "item=dock item: 1 file" in open(core_log).read(), 20)
    check("a file opened with the app is held for the quick panel", held)
    logs = open(core_log).read() + open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("the file's path is never logged", "smoke-dropped-report" not in logs)


def read_logs():
    """Both logs of this run, every rotated file included."""
    folder = os.path.join(SHELL_DATA, "logs")
    text = {}
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        with open(os.path.join(folder, name), errors="replace") as f:
            text[name] = f.read()
    return text


def check_logs():
    """After quitting: the two logs tell the run's story and hold nothing private."""
    files = read_logs()
    core, shell = files.get("core.log", ""), files.get("shell.log", "")
    check("the core and the shell each wrote their log", core and shell, sorted(files))
    for told in ["the core is starting", "database", "the core is ready", "the window is up", "the core stopped"]:
        check(f"core.log tells {told!r}", told in core)
    for told in ["shell: started", "views: dashboard view opened", "shell: quitting", "shell: stopped"]:
        check(f"shell.log tells {told!r}", told in shell)
    everything = "\n".join(files.values())
    secrets = ["smoke-not-a-real-invite", os.path.expanduser("~") + "/"]
    try:
        with open(os.path.join(DEV_HOME, "ui-token")) as f:
            secrets.append(f.read().strip())
    except OSError:
        pass
    leaked = [s for s in secrets if s and s in everything]
    check("no ui-token, link or home folder in the logs", not leaked, leaked)
    emails = re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}", everything)
    check("no e-mail address in the logs", not emails, emails[:3])
    queries = re.findall(r"\?[^\s\"'<]*=", everything)
    check("no URL query in the logs", not queries, queries[:3])
    check("no line was dropped", "dropped: the log could not keep up" not in everything)


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
        check_logs()
    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else code


if __name__ == "__main__":
    sys.exit(main())
