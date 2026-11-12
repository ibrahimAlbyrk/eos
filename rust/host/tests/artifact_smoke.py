#!/usr/bin/env python3
"""Artifact views on the real bundle, against a LOCAL page standing in for claude.ai.

A server on 127.0.0.1 serves the viewer's URL shape (`/artifact/<short id>`) and a sign-in
page; the app is started with it as the artifact origin (a dev-proxy build only accepts
one). The steps call `eosArtifacts` in process as the dashboard does: a view of a profile
with no sign-in asks for one, the sign-in window signs the profile in (the local page sets
the cookie itself), the view loads, moves into a tab and into the peek and back without a
reload (the page reports its zoom and whether the shield covers it), reloads behind itself
and swaps, leaves a still, and a page that leaves the viewer is refused. The machine
switcher names this computer and switches to no computer it does not know (a dev run never
reaches a paired one; their views are covered by eos-bridge's tests).

Rules it keeps (see smoke.py): claude.ai is never loaded, nothing is typed anywhere, the
window opens without taking the focus, and everything it started is stopped at the end,
also when it is killed.

usage: artifact_smoke.py <path to Eos.app>
"""
import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (shared helpers; smoke.APP comes from the same argv)

OUT = os.path.join(smoke.DEV_OUT, "artifact-smoke")
SHELL_DATA = os.path.join(OUT, "data")
smoke.SHELL_DATA = SHELL_DATA

# Three artifacts: A is the one that moves around, B belongs to a sign-in that never signs
# in, C's page tries to leave the viewer while it loads.
A = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
B = "5d7c1e40-9a1b-4c2d-8e3f-1a2b3c4d5e6f"
C = "6e8d2f51-0b2c-4d3e-9f40-2b3c4d5e6f70"
SHORT = {"2NC37Mk7spnA7bv13mCd5k": "A", "CYYhd2Q6dHFw5xpBekVHqY": "B"}

ARTIFACT = """<!doctype html><meta charset="utf-8"><title>Artifact {name}</title>
<body style="margin:0;font:16px system-ui"><h1 style="margin:20px">Artifact {name}</h1>
<div style="height:2000px;background:linear-gradient(#36c,#c63)"></div>
<script>
  {leave}
  setInterval(() => {{
    const zoom = getComputedStyle(document.documentElement).zoom;
    const shield = !!document.querySelector("eos-artifact-shield");
    fetch("/report?name={name}&zoom=" + zoom + "&shield=" + shield).catch(() => {{}});
  }}, 150);
</script>"""
LOGIN = """<!doctype html><title>Sign in</title><p>Signing in…</p>
<script>document.cookie = "sessionKey=smoke-session; path=/"; setTimeout(() => location.href = "/new", 300);</script>"""
NEW = "<!doctype html><title>Signed in</title><p>Signed in.</p>"


class Pages(http.server.BaseHTTPRequestHandler):
    loads = {}
    # Every report of each page, in order: the steps run faster than anyone can sample.
    reports = {}
    lock = threading.Lock()

    def log_message(self, *a):
        pass

    def send(self, body, kind="text/html"):
        data = body.encode()
        self.send_response(200)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path.startswith("/artifact/"):
            short = url.path[len("/artifact/"):]
            name = SHORT.get(short, "C")
            with Pages.lock:
                Pages.loads[name] = Pages.loads.get(name, 0) + 1
            leave = 'location.href = "/elsewhere";' if name == "C" else ""
            return self.send(ARTIFACT.format(name=name, leave=leave))
        if url.path == "/report":
            q = urllib.parse.parse_qs(url.query)
            with Pages.lock:
                seen = Pages.reports.setdefault(q["name"][0], [])
                if len(seen) < 5000:
                    seen.append({"zoom": q["zoom"][0], "shield": q["shield"][0] == "true"})
            return self.send("{}", "application/json")
        if url.path == "/login":
            return self.send(LOGIN)
        return self.send(NEW)


def serve():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Pages)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def art(slug, login="smoke", version="v1"):
    return {"slug": slug, "loginId": login, "url": "", "version": version}


def call(verb, body=None):
    return {"artifacts": {"verb": verb, "body": body or {}}}


def reports(name):
    with Pages.lock:
        return list(Pages.reports.get(name) or [])


def main():
    if not os.path.isfile(smoke.BIN):
        print(__doc__)
        return 2
    if smoke.ctl("--status").get("running"):
        print("an app is already running on this data folder; quit it first")
        return 2
    run = smoke.Run()
    server, origin = serve()
    try:
        return checks(origin)
    finally:
        run.close()
        server.shutdown()


def checks(origin):
    check = smoke.check
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)
    tab = {"tabKey": "artifact:smoke"}
    steps = [
        call("status"),                                                         # 0
        call("warm", {"ref": art(A)}),                                           # 1
        {"wait": 1500},                                                          # 2
        call("state", {"slug": A}),                                              # 3  signin
        call("signIn", {"loginId": "smoke"}),                                    # 4
        {"wait": 3000},                                                          # 5
        call("state", {"slug": A}),                                              # 6  ready
        call("attach", {**tab, "ref": art(A), "rect": {"x": 120, "y": 90, "width": 640, "height": 420}}),  # 7
        {"wait": 600},                                                           # 8
        call("status"),                                                          # 9  tab, shown
        call("peek", {"ref": art(A), "rect": {"x": 60, "y": 60, "width": 320, "height": 210}}),  # 10
        {"wait": 1200},                                                          # 11 (report: zoomed, shielded)
        call("status"),                                                          # 12
        call("unpeek"),                                                          # 13
        {"wait": 1200},                                                          # 14 (report: plain)
        call("status"),                                                          # 15
        call("still", {"ref": art(A)}),                                          # 16
        call("reload", {"slug": A}),                                             # 17
        {"wait": 3500},                                                          # 18
        call("status"),                                                          # 19 one view, swapped
        call("detach", tab),                                                     # 20
        call("warm", {"ref": art(B, login="nobody")}),                           # 21
        call("warm", {"ref": art(C)}),                                           # 22
        {"wait": 2500},                                                          # 23
        call("state", {"slug": B}),                                              # 24 signin
        call("state", {"slug": C}),                                              # 25 error
        call("status"),                                                          # 26
        call("account", {"loginId": "smoke"}),                                   # 27
        call("frobnicate"),                                                      # 28
        {"hosts": {"verb": "list"}},                                             # 29
        {"hosts": {"verb": "switchTo", "id": "not-a-paired-computer"}},          # 30
    ]
    steps_file, steps_out = os.path.join(OUT, "steps.json"), os.path.join(OUT, "steps-out.json")
    with open(steps_file, "w") as f:
        json.dump(steps, f)
    env = dict(os.environ, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none", EOS_DEV_SCRIPT=steps_file,
               EOS_DEV_SCRIPT_OUT=steps_out, EOS_DEV_ARTIFACT_ORIGIN=origin)
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet"], check=True, env=env)

    out = smoke.wait_for("steps", lambda: (lambda o: o if o and o.get("done") else None)(smoke.read_json(steps_out)), 120)
    if not check("the scripted steps finished", out, "" if out else "not within the time"):
        return 1
    r = out["results"]
    value = lambda i: r[i].get("value")  # noqa: E731
    views = lambda i: (value(i) or {}).get("views") or []  # noqa: E731

    check("no artifact view before the first warm", views(0) == [], value(0))
    check("a profile with no claude.ai sign-in asks for one", value(3) == "signin", value(3))
    check("the sign-in window signed the profile in", value(4) == {"signedIn": True}, value(4) or r[4].get("error"))
    check("the view waiting for it loaded", value(6) == "ready", value(6))
    check("attached to a tab it is on screen", views(9) == [{"state": "ready", "place": "tab", "shown": True, "replacing": False}], views(9))
    check("the peek takes the same view", [v["place"] for v in views(12)] == ["peek"] and views(12)[0]["shown"], views(12))
    seen = reports("A")
    peeked = [i for i, r in enumerate(seen) if r == {"zoom": "0.5", "shield": True}]
    check("in the peek the page is half size under the shield", peeked, f"{len(peeked)} of {len(seen)} reports")
    after = seen[peeked[-1] + 1:] if peeked else []
    check("back in the tab it is whole and the shield is gone", after and all(r == {"zoom": "1", "shield": False} for r in after), after[-1:] or seen[-1:])
    still = value(16) or ""
    check("a still of the ready view was kept", still.startswith("data:image/jpeg;base64,") and len(still) > 2000, f"{len(still)} chars")
    check("a reload loads behind the view and swaps it in; nothing else ever reloaded it", views(19) == [{"state": "ready", "place": "tab", "shown": True, "replacing": False}] and Pages.loads.get("A") == 2, (views(19), Pages.loads))
    stills = os.listdir(os.path.join(SHELL_DATA, "artifact-stills")) if os.path.isdir(os.path.join(SHELL_DATA, "artifact-stills")) else []
    check("stills are kept per artifact and version", f"{A}@v1.jpg" in stills, stills)
    check("another sign-in's profile is separate: still not signed in", value(24) == "signin", value(24))
    check("a page that leaves the viewer while it loads is refused", value(25) == "error", value(25))
    check("after detach no view is on screen", not any(v["shown"] for v in views(26)) and len(views(26)) == 3, views(26))
    check("the account of a signed-in profile says so", value(27) == {"signedIn": True}, value(27))
    check("an unknown verb is refused", r[28].get("ok") is False, r[28].get("error"))
    switcher = value(29) or {}
    check("the machine switcher names this computer", bool((switcher.get("local") or {}).get("name")) and switcher.get("active") is None)
    check("it switches to no computer it does not know", (value(30) or {}).get("active") is None and (value(30) or {}).get("hosts") == [])

    st = smoke.ctl("--status")
    check("the app is still up; the dashboard was not driven", st.get("running") and smoke.bridge_of(st).get("panel", {}).get("view") is None)
    log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read()
    check("nothing failed in the shell's log", "failed" not in log and "could not" not in log and "panic" not in log)

    failed = [name for name, ok in smoke.results if not ok]
    print(f"\n{len(smoke.results) - len(failed)}/{len(smoke.results)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
