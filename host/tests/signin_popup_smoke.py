#!/usr/bin/env python3
"""The claude.ai sign-in window and an identity provider's popup, on the real bundle,
against LOCAL pages standing in for claude.ai and for the provider.

claude.ai's "Continue with Google" is Google Identity Services' code client in popup mode:
the login page calls `window.open("https://accounts.google.com/o/oauth2/v2/auth?…
&display=popup&redirect_uri=gis_transform…", "g_auth_code_window_…", "width=590,…")`; the
popup, once the user has chosen an account, hands the code back to its opener with
`postMessage`, and the page then posts it to `/api/auth/verify_google`. When `window.open`
returns null, GIS reports `popup_failed_to_open` and claude.ai shows "There was an error
logging you in. If the problem persists contact support for assistance."

Two local servers: the claude.ai stand-in at `http://127.0.0.1:<p>` (the artifact views'
origin, `EOS_DEV_ARTIFACT_ORIGIN`) and the provider stand-in at `http://localhost:<q>`
(`EOS_DEV_SIGNIN_PROVIDER`: the one origin besides Google's that the sign-in window's
popups may open on and visit in this run). Checked:

- a browser view (not the sign-in window) of the same profile asks, on a real click, for a
  popup on the provider: refused;
- in the sign-in window (opened as the dashboard's "Sign in" does), a popup on a host that is
  not a provider is refused, with a click and without one; a click on the provider's button
  opens it: `/start` redirects to `/popup` on the provider, which has its opener, no Tauri
  bridge, the sign-in window's profile (a cookie set there earlier in a browser view), posts
  its code back and the page signs in; the popup cannot open a window and cannot leave the
  provider's origin;
- closing the sign-in window closes the popup (its heartbeat stops);
- the shell's log names only hosts.

Rules (see smoke.py): claude.ai and Google are never loaded, nothing is typed anywhere, the
window opens without taking the focus, everything it started is stopped at the end. In this
run (only), the stand-ins' pages may ask for a window without a click, so the popup policy,
not Chromium's popup blocker, is what answers them.

usage: signin_popup_smoke.py <path to Eos.app>
"""
import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402

OUT = os.path.join(smoke.DEV_OUT, "signin-popup-smoke")
SHELL_DATA = os.path.join(OUT, "data")
smoke.SHELL_DATA = SHELL_DATA
PROFILE = "claude-smoke"  # the sign-in window's profile for login "smoke"

# The sign-in window is 460 × 720: the left half asks for a popup on a host that is not a
# provider, the right half for the provider's.
LOGIN = """<!doctype html><title>Sign in</title><p id="s">Signing in…</p>
<button id="bad" style="position:fixed;left:0;top:0;width:50%;height:100%">Elsewhere</button>
<button id="go" style="position:fixed;right:0;top:0;width:50%;height:100%">Continue with Google</button>
<script>
  const report = (step, value) => fetch("/report?step=" + step + "&value=" + encodeURIComponent(value)).catch(() => {});
  addEventListener("message", (e) => {
    if (e.origin !== "PROVIDER" || !e.data || e.data.code !== "stand-in-code") return;
    report("message", "received");
    // As claude.ai does with the code; the window stays on the sign-in page until closed.
    fetch("/verify", { method: "POST" }).then(() => report("verified", "yes"));
  });
  const open = (step, url) => {
    const w = window.open(url, "g_auth_code_window_standin",
      "toolbar=no,location=no,menubar=no,width=590,height=560,top=20,left=105");
    report(step, w ? "window" : "null");
  };
  open("open-elsewhere-unclicked", "/elsewhere");
  document.getElementById("bad").addEventListener("click", () => open("open-elsewhere", "/elsewhere"));
  document.getElementById("go").addEventListener("click", () => open("window-open", "PROVIDER/start"));
</script>"""
# A browser view of the same profile: a click asks for the provider's popup.
OPENER = """<!doctype html><title>Opener</title>
<button id="go" style="position:fixed;inset:0;width:100%;height:100%">Open</button>
<script>
  document.getElementById("go").addEventListener("click", () => {
    const w = window.open("PROVIDER/start", "g_auth_code_window_standin", "width=590,height=560");
    fetch("/report?step=browser-window-open&value=" + (w ? "window" : "null"));
  });
</script>"""
POPUP = """<!doctype html><title>Choose an account</title><p>Stand-in identity provider</p>
<script>
  const report = (step, value) => fetch("/report?step=" + step + "&value=" + encodeURIComponent(value));
  (async () => {
    await report("popup-loaded", "yes");
    await report("popup-opener", !!window.opener);
    await report("popup-bridge", typeof window.ipc + "/" + typeof window.__TAURI_INTERNALS__);
    const w = window.open("/start", "nested", "width=300,height=300");
    await report("popup-window-open", w ? "window" : "null");
    if (window.opener) window.opener.postMessage({ code: "stand-in-code" }, "ORIGIN");
    setInterval(() => fetch("/beat"), 200);
    // Off the provider's origin: must not load.
    setTimeout(() => { location.href = "ORIGIN/escape"; }, 600);
  })();
</script>"""
NEW = "<!doctype html><title>Signed in</title><p>Signed in.</p>"


class Pages(http.server.BaseHTTPRequestHandler):
    steps = {}
    beats = []
    lock = threading.Lock()
    origin = provider = ""

    def log_message(self, *a):
        pass

    def note(self, step, value):
        with Pages.lock:
            Pages.steps[step] = value

    def send(self, body, kind="text/html", cookie=None, status=200, location=None):
        data = body.replace("PROVIDER", Pages.provider).replace("ORIGIN", Pages.origin).encode()
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        if cookie:
            self.send_header("set-cookie", cookie)
        if location:
            self.send_header("location", location)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/verify":
            self.note("verify", "posted")
            return self.send("{}", "application/json", cookie="sessionKey=stand-in-session; Path=/; Max-Age=3600")
        return self.send("{}", "application/json")

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        host = self.headers.get("host", "")
        if url.path == "/report":
            q = urllib.parse.parse_qs(url.query)
            self.note(q["step"][0], q.get("value", [""])[0])
            return self.send("{}", "application/json")
        if url.path == "/beat":
            with Pages.lock:
                Pages.beats.append(time.time())
            return self.send("{}", "application/json")
        if url.path in ("/elsewhere", "/escape", "/after-close"):
            self.note(url.path[1:], time.time())
            return self.send(NEW)
        if host.startswith("localhost"):
            if url.path == "/mark":
                return self.send("<p>marked</p>", cookie="providerMark=1; Path=/; Max-Age=3600")
            if url.path == "/start":
                with Pages.lock:
                    n = len([k for k in Pages.steps if k.startswith("start-")])
                    Pages.steps[f"start-{n}"] = "requested"
                return self.send("", status=302, location="/popup")
            if url.path == "/popup":
                self.note("popup-cookie", "providerMark=1" in self.headers.get("cookie", ""))
                return self.send(POPUP)
            return self.send(NEW)
        if url.path == "/login":
            return self.send(LOGIN)
        if url.path == "/opener":
            return self.send(OPENER)
        if url.path == "/api/account":
            return self.send('{"uuid": "u-smoke", "email_address": "smoke@example.test"}', "application/json")
        return self.send(NEW)


def serve():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    servers = [socketserver.ThreadingTCPServer(("127.0.0.1", 0), Pages) for _ in range(2)]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    Pages.origin = f"http://127.0.0.1:{servers[0].server_address[1]}"
    Pages.provider = f"http://localhost:{servers[1].server_address[1]}"
    return servers


def seen():
    with Pages.lock:
        return dict(Pages.steps), list(Pages.beats)


def main():
    if not os.path.isfile(smoke.BIN):
        print(__doc__)
        return 2
    if smoke.ctl("--status").get("running"):
        print("an app is already running on this data folder; quit it first")
        return 2
    run = smoke.Run(max_seconds=150)
    servers = serve()
    try:
        return checks()
    finally:
        run.close()
        for server in servers:
            server.shutdown()


def checks():
    check = smoke.check
    origin, provider = Pages.origin, Pages.provider
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)

    def click(target, x, y):
        return [{target[0]: dict(target[1], method="Input.dispatchMouseEvent", params={
            "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})} for kind in ("mousePressed", "mouseReleased")]
    in_browser = ("cdp", {"view": "c"})
    in_sign_in = ("signin", {"profile": PROFILE})
    steps = [
        # A browser view of the sign-in window's profile: the provider sets a cookie there,
        # then a click asks for a popup on the provider.
        {"create": {"as": "c", "profile": PROFILE, "url": provider + "/mark"}},
        {"wait": 1000},
        {"cdp": {"view": "c", "method": "Page.navigate", "params": {"url": origin + "/opener"}}},
        {"place": {"view": "c", "rect": [0, 0, 460, 400]}},
        {"wait": 1500},
        *click(in_browser, 200, 150),
        {"wait": 1000},
        {"close": "c"},
        # The sign-in window, as the dashboard's "Sign in" opens it (the call waits for it).
        {"artifacts": {"verb": "signIn", "body": {"loginId": "smoke"}, "background": True}},
        {"wait": 3000},
        *click(in_sign_in, 115, 360),
        {"wait": 800},
        *click(in_sign_in, 345, 360),
        {"wait": 4000},
        {"signin": {"profile": PROFILE, "close": True}},
        {"wait": 2500},
        # A page loaded after the close: the popup's heartbeat must have stopped before it.
        {"create": {"as": "d", "profile": "after", "url": origin + "/after-close"}},
        {"wait": 1000},
        {"close": "d"},
        {"artifacts": {"verb": "account", "body": {"loginId": "smoke"}}},
    ]
    steps_file, steps_out = os.path.join(OUT, "steps.json"), os.path.join(OUT, "steps-out.json")
    with open(steps_file, "w") as f:
        json.dump(steps, f)
    env = dict(os.environ, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none", EOS_DEV_SCRIPT=steps_file,
               EOS_DEV_SCRIPT_OUT=steps_out, EOS_DEV_ARTIFACT_ORIGIN=origin, EOS_DEV_SIGNIN_PROVIDER=provider)
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet"], check=True, env=env)

    out = smoke.wait_for("steps", lambda: (lambda o: o if o and o.get("done") else None)(smoke.read_json(steps_out)), 120)
    s, beats = seen()
    print("stand-in steps:", {k: v for k, v in s.items() if not isinstance(v, float)})
    r = (out or {}).get("results") or []
    failed_steps = [(i, x.get("error")) for i, x in enumerate(r) if x.get("ok") is False]
    check("the scripted steps ran", len(r) == len(steps) and not failed_steps, failed_steps or len(r))

    check("a browser view's popup on the provider is refused", s.get("browser-window-open") == "null", s.get("browser-window-open"))
    check("the sign-in window refuses a popup on a host that is not a provider (clicked)",
          s.get("open-elsewhere") == "null", s.get("open-elsewhere"))
    check("… and without a click (the policy answered, not the popup blocker)",
          s.get("open-elsewhere-unclicked") == "null", s.get("open-elsewhere-unclicked"))
    check("no refused popup loaded", "elsewhere" not in s, s.get("elsewhere"))
    check("the login page's window.open got a window (GIS popup mode)", s.get("window-open") == "window", s.get("window-open"))
    check("only the sign-in window's popup reached the provider", s.get("start-0") == "requested" and "start-1" not in s,
          sorted(k for k in s if k.startswith("start-")))
    check("the popup followed the provider's redirect and loaded", s.get("popup-loaded") == "yes", s.get("popup-loaded"))
    check("the popup has its opener", s.get("popup-opener") == "true", s.get("popup-opener"))
    check("the popup has no Tauri bridge", s.get("popup-bridge") == "undefined/undefined", s.get("popup-bridge"))
    check("the popup shares the sign-in window's profile (the provider's cookie is sent)", s.get("popup-cookie") is True,
          s.get("popup-cookie"))
    check("the popup cannot open a window", s.get("popup-window-open") == "null", s.get("popup-window-open"))
    check("the popup's postMessage reached the login page", s.get("message") == "received", s.get("message"))
    check("the popup cannot leave the provider's origin", "escape" not in s, s.get("escape"))
    after = s.get("after-close")
    check("the popup lived until the window closed", len(beats) >= 10, f"{len(beats)} beats")
    check("closing the sign-in window closed the popup", bool(beats) and bool(after) and beats[-1] < after - 1.5,
          f"last beat {after - beats[-1]:.1f} s before the page after the close" if beats and after else (beats[-1:], after))
    signed = (r[-1].get("value") or {}).get("signedIn") if r else None
    check("the sign-in's profile is signed in", signed is True, r[-1] if r else "no answer")

    try:
        with open(os.path.join(SHELL_DATA, "logs", "shell.log")) as f:
            log = [line for line in f if "popup" in line]
    except OSError:
        log = []
    print("".join(log), end="")
    joined = "".join(log)
    check("the log says which popups opened and which did not",
          "popup of the sign-in window view opened on localhost" in joined
          and joined.count("popup of the sign-in window view was not opened: 127.0.0.1") == 2
          and "popup of the browser view was not opened: localhost" in joined
          and "popup of the sign-in window view was kept from 127.0.0.1" in joined, len(log))
    check("the log names hosts only", "/start" not in joined and "/escape" not in joined and "http" not in joined)

    failed = [name for name, ok in smoke.results if not ok]
    print(f"\n{len(smoke.results) - len(failed)}/{len(smoke.results)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
