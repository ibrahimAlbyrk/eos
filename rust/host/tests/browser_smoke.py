#!/usr/bin/env python3
"""The browser feature on the real bundle, driving a LOCAL test page.

A page served from a temporary folder on 127.0.0.1 is opened, read and driven through the
Rust core's own browser routes, called in process as an agent's `browser_*` tools call them
(the dev script's `browser` steps): open a tab, snapshot, type, click, read, press a key,
wait, find, capture, full-page capture, a popup that becomes a tab, device emulation, mute,
close. The tabs are never put on screen: everything runs on hidden views.

Rules it keeps (see smoke.py): no third-party site is loaded, nothing is typed into the
dashboard, the window opens without taking the focus, and everything it started is stopped
at the end, also when it is killed.

usage: browser_smoke.py <path to Eos.app>
"""
import http.server
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (shared helpers; smoke.APP comes from the same argv)

OUT = os.path.join(smoke.DEV_OUT, "browser-smoke")
SHELL_DATA = os.path.join(OUT, "data")
smoke.SHELL_DATA = SHELL_DATA

PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eos test page</title>
<body style="margin:20px;font:16px system-ui">
<h1>Greeter</h1>
<form onsubmit="event.preventDefault(); greet()">
  <label>Name <input id="name" type="text"></label>
  <label><input id="loud" type="checkbox"> Loud</label>
  <button id="go" type="submit">Greet</button>
</form>
<p id="out">Nobody yet</p>
<p id="facts"></p>
<a id="more" href="/second.html" target="_blank">Open the second page</a>
<div style="height:2400px"></div>
<p id="end">The end of the page</p>
<script>
  let trusted = null;
  document.getElementById("go").addEventListener("click", (e) => { trusted = e.isTrusted; });
  function greet() {
    const name = document.getElementById("name").value;
    const loud = document.getElementById("loud").checked;
    document.getElementById("out").textContent = (loud ? "HELLO, " : "Hello, ") + name + (trusted === null ? " (enter)" : trusted ? " (trusted click)" : " (script click)");
    document.title = "Greeted " + name;
    trusted = null;
  }
  document.getElementById("facts").textContent = "width " + innerWidth + " touch " + navigator.maxTouchPoints + " agent " + (/iPhone/.test(navigator.userAgent) ? "iPhone" : "desktop") + " visible " + document.visibilityState;
</script>
"""
PLUGIN = "preview-smoke"
PLUGIN_UI = """export default function activate(eos) {
  function View() {
    return (
      <div style={{ padding: 40 }}>
        <h1 style={{ fontSize: 40 }}>Preview smoke</h1>
        <p>Drawn in a hidden view of the dashboard's own bundle.</p>
        <div style={{ width: 300, height: 120, background: "linear-gradient(90deg, #c63, #36c)" }} />
      </div>
    );
  }
  eos.mainView({ id: "main", Component: View });
}
"""
SECOND = "<!doctype html><title>Second page</title><h1>Second</h1><p>Opened by the first.</p>"


def serve(folder):
    """Serves `folder` on a free port of 127.0.0.1; returns the server and its address."""
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=folder, **k)  # noqa: E731
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a, **k: None
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def main():
    if not os.path.isfile(smoke.BIN):
        print(__doc__)
        return 2
    if smoke.ctl("--status").get("running"):
        print("an app is already running on this data folder; quit it first")
        return 2
    run = smoke.Run()
    with tempfile.TemporaryDirectory(prefix="eos-browser-smoke-") as folder:
        with open(os.path.join(folder, "index.html"), "w") as f:
            f.write(PAGE)
        with open(os.path.join(folder, "second.html"), "w") as f:
            f.write(SECOND)
        server, base = serve(folder)
        try:
            return checks(base)
        finally:
            run.close()
            server.shutdown()


def checks(base):
    check = smoke.check
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)
    status, workers = smoke.daemon("/workers")
    roots = [w for w in (workers or []) if isinstance(w, dict) and not w.get("parent_id") and not w.get("archived_at")] if status == 200 else []
    if not check("the isolated daemon lists chats", roots, f"{len(roots)} top-level"):
        return 1
    agent = roots[0]["id"]  # the agent the calls are attributed to: its session's browser

    def call(method, path, body=None, tab=None, as_user=False):
        step = {"method": method, "path": path}
        if body is not None:
            step["body"] = body
        if tab:
            step["tab"] = tab
        if not as_user:
            step["agent"] = agent
        return {"browser": step}

    act = lambda body: call("POST", "/browser/tabs/{t}/act", body)  # noqa: E731
    steps = [
        call("GET", "/browser/status"),                                                    # 0
        call("POST", "/browser/tabs", {"url": base + "/index.html"}, tab="t"),            # 1
        call("POST", "/browser/tabs/{t}/wait", {"forText": "Nobody yet", "timeoutMs": 8000}),  # 2
        call("POST", "/browser/tabs/{t}/snapshot", {}),                                    # 3
        act({"ref": "@e1", "text": "Eos"}),                                                # 4  type
        act({"ref": "@e3", "verb": "click"}),                                              # 5  click
        call("POST", "/browser/tabs/{t}/get", {"what": "text"}),                           # 6
        act({"ref": "@e2", "verb": "check"}),                                              # 7
        act({"ref": "@e1", "verb": "focus"}),                                              # 8
        act({"key": "Enter"}),                                                             # 9  press
        call("POST", "/browser/tabs/{t}/wait", {"forText": "HELLO, Eos", "timeoutMs": 5000}),  # 10
        call("POST", "/browser/tabs/{t}/get", {"what": "value", "ref": "@e1"}),            # 11
        call("POST", "/browser/tabs/{t}/find", {"query": "/^open the/"}),                  # 12
        act({"direction": "bottom"}),                                                      # 13 scroll
        call("POST", "/browser/tabs/{t}/capture", {}),                                     # 14
        call("POST", "/browser/tabs/{t}/capture", {"fullPage": True}),                     # 15
        call("GET", "/browser/tabs"),                                                      # 16
        call("GET", "/browser/active-tab"),                                                # 17
        # A page's own popup: the link opens a new window, which becomes a tab.
        call("POST", "/browser/tabs/{t}/snapshot", {}),                                    # 18
        act({"ref": "@e9", "verb": "click"}),                                              # 19
        {"wait": 1500},                                                                    # 20
        call("GET", "/browser/tabs"),                                                      # 21
        # The same tab as a phone.
        call("POST", "/browser/tabs/{t}/device", {"device": "mobile"}),                    # 22
        call("POST", "/browser/tabs/{t}/wait", {"forText": "agent iPhone", "timeoutMs": 8000}),  # 23
        call("POST", "/browser/tabs/{t}/get", {"what": "text"}),                           # 24
        call("POST", "/browser/tabs/{t}/device", {"device": "responsive"}),                # 25
        call("POST", "/browser/tabs/{t}/wait", {"forText": "agent desktop", "timeoutMs": 8000}),  # 26
        call("POST", "/browser/tabs/{t}/mute", {"muted": True}),                           # 27
        call("POST", "/browser/show", {}),                                                 # 28
        # Fences: the user's window on the global session may not touch the agent's tab,
        # and a route outside the browser cannot be reached from a script at all.
        call("POST", "/browser/tabs/{t}/snapshot", {}, as_user=True),                      # 29
        call("POST", "/workers/x/message", {"text": "never"}),                             # 30
        call("POST", "/browser/tabs/{t}/navigate", {"action": "url", "url": base + "/second.html"}),  # 31
        call("POST", "/browser/tabs/{t}/wait", {"forText": "Opened by the first", "timeoutMs": 8000}),  # 32
        call("POST", "/browser/tabs/{t}/navigate", {"action": "back"}),                    # 33
        call("POST", "/browser/tabs/{t}/wait", {"forText": "Greeter", "timeoutMs": 8000}),  # 34
        call("DELETE", "/browser/tabs/{t}"),                                               # 35
        call("GET", "/browser/tabs"),                                                      # 36
        # A plugin's surface drawn in a hidden view of the dashboard's bundle.
        call("POST", f"/api/plugins/{PLUGIN}/preview", {"surface": "main", "waitMs": 0}, as_user=True),  # 37
    ]
    # A plugin of the test's own, in the isolated data folder: removed again at the end.
    plugin_dir = os.path.join(smoke.DEV_HOME, "plugins", PLUGIN)
    os.makedirs(plugin_dir, exist_ok=True)
    with open(os.path.join(plugin_dir, "plugin.json"), "w") as f:
        json.dump({"id": PLUGIN, "name": "Preview smoke", "description": "Drawn by the browser smoke run.", "version": "0.0.1"}, f)
    with open(os.path.join(plugin_dir, "ui.jsx"), "w") as f:
        f.write(PLUGIN_UI)
    try:
        return drive(steps, base, agent)
    finally:
        subprocess.run(["rm", "-rf", plugin_dir], check=True)


def drive(steps, base, agent):
    check = smoke.check
    steps_file, steps_out = os.path.join(OUT, "steps.json"), os.path.join(OUT, "steps-out.json")
    with open(steps_file, "w") as f:
        json.dump(steps, f)
    env = dict(os.environ, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none", EOS_DEV_SCRIPT=steps_file, EOS_DEV_SCRIPT_OUT=steps_out)
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet"], check=True, env=env)
    out = smoke.wait_for("steps", lambda: (lambda o: o if o and o.get("done") else None)(smoke.read_json(steps_out)), 120)
    if not check("the scripted steps finished", out, "" if out else "not within 120 s"):
        return 1
    r = out["results"]
    body = lambda i: (r[i].get("value") or {}).get("body") or {}  # noqa: E731
    code = lambda i: (r[i].get("value") or {}).get("status")  # noqa: E731
    ms = lambda i: f"{r[i].get('ms')} ms"  # noqa: E731

    check("the browser is there before its first use", code(0) == 200 and body(0).get("state") == "launching", body(0).get("state"))
    tab = body(1).get("tabId")
    check("an agent opened a tab on the local page", code(1) == 200 and tab, ms(1))
    check("the page loaded in a view nobody sees", body(2).get("ok") is True, ms(2))
    snap = body(3).get("snapshot", "")
    wanted = ['textbox "Name" @e1', 'checkbox "Loud" @e2', 'button "Greet" @e3', 'link "Open the second page" @e4', 'heading "Greeter"']
    check("the snapshot names the page's controls with refs", all(w in snap for w in wanted), snap.replace("\n", " | ")[:200])
    check("typing went into the field", code(4) == 200, ms(4))
    check("a click on a ref reached the page", code(5) == 200, ms(5))
    text = body(6).get("value", "")
    check("the click was a trusted one and the typed text arrived", "Hello, Eos (trusted click)" in text, text[:60].replace("\n", " "))
    check("checking a box and pressing Enter submit the form", code(7) == 200 and code(9) == 200 and body(10).get("ok") is True, f"waited {body(10).get('elapsedMs')} ms")
    check("a field's value can be read", body(11).get("value") == "Eos", body(11).get("value"))
    found = body(12).get("matches") or []
    check("find answers an element with a durable locator", len(found) == 1 and found[0].get("locator") == 'role=link[name="Open the second page"]' and found[0].get("tag") == "a", found[:1])
    shots = [body(14).get("path"), body(15).get("path")]
    sizes = [os.path.getsize(p) if p and os.path.exists(p) else 0 for p in shots]
    jpeg = all(p and open(p, "rb").read(3) == b"\xff\xd8\xff" for p in shots if p and os.path.exists(p))
    check("a hidden view is captured, as a JPEG file", sizes[0] > 2000 and jpeg, f"{sizes[0]} bytes, {ms(14)}")
    check("the whole page is captured too", sizes[1] > sizes[0], f"{sizes[1]} bytes, {ms(15)}")
    tabs = body(16).get("tabs") or []
    check("the tab list shows the page's title and address", len(tabs) == 1 and tabs[0].get("title") == "Greeted Eos" and tabs[0].get("url") == base + "/index.html", tabs[:1])
    check("the session's tab is its own, and it is 'this page'", body(16).get("sessionId") == agent and body(17).get("tabId") == tab)
    tabs = body(21).get("tabs") or []
    check("a page's popup became a tab of the same session", code(19) == 200 and len(tabs) == 2 and tabs[1].get("url") == base + "/second.html", [t.get("url") for t in tabs])
    phone = body(24).get("value", "")
    check("device emulation: the page sees a phone", code(22) == 200 and body(23).get("ok") is True and "width 375" in phone and "touch 5" in phone, phone[phone.find("width"):][:60] or r[22].get("error") or body(22))
    check("and a desktop again afterwards", code(25) == 200 and body(26).get("ok") is True, body(25) if code(25) != 200 else "")
    check("mute and show answer", code(27) == 200 and body(28).get("tabId") == tab)
    check("another session's caller is fenced off the tab", code(29) == 403, body(29).get("error"))
    check("a script cannot reach any other route of the core", r[30].get("ok") is False, r[30].get("error", "")[:70])
    check("navigating by address and going back work", body(32).get("ok") is True and body(34).get("ok") is True)
    left = body(36).get("tabs") or []
    check("closing the tab leaves only the popup's", code(35) == 200 and len(left) == 1 and left[0].get("url") == base + "/second.html")
    for p in shots:
        if p and os.path.exists(p):
            os.remove(p)
    drawn = body(37)
    png = drawn.get("path")
    is_png = bool(png) and os.path.exists(png) and open(png, "rb").read(8) == b"\x89PNG\r\n\x1a\n"
    check("a plugin's surface was drawn off screen, as a PNG file", code(37) == 200 and is_png and os.path.getsize(png) > 1500 and drawn.get("errors") == [],
          {k: drawn.get(k) for k in ("surface", "view", "width", "height", "errors", "error")} | {"ms": r[37].get("ms")})
    if is_png:
        os.remove(png)

    st = smoke.ctl("--status")
    core = smoke.bridge_of(st).get("core") or {}
    views = [v for v in st.get("views") or []]
    check("no tab was ever on screen", views and not any(v.get("placed") for v in views), views)
    check("the app is still up; the dashboard was not driven", st.get("running") and smoke.bridge_of(st).get("panel", {}).get("view") is None, {k: core.get(k) for k in ("rust", "proxy", "rustRefused")})
    log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("nothing failed in the shell's log", "failed" not in log and "could not" not in log and "panic" not in log)

    failed = [name for name, ok in smoke.results if not ok]
    print(f"\n{len(smoke.results) - len(failed)}/{len(smoke.results)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
