#!/usr/bin/env python3
"""Does a third-party page make the app touch the local network?

macOS answers any traffic to the local network (a LAN address, mDNS, SSDP) with the dialog
"Allow … to find devices on local networks?" in the app's name. A sign-in page did that to
the shell gate. This run opens a public page (example.com) in a test view and, through the
DevTools channel, makes it do what such pages do:

  - WebRTC candidate gathering (host candidates mean mDNS names or LAN addresses);
  - the Presentation and Remote Playback APIs (device discovery: DIAL / mDNS);
  - requests to LAN addresses and a `.local` name, as fetch, image and WebSocket.

It reports what the page saw, which sockets the app's processes held during the probe
(sampled with lsof) and whether a system dialog window appeared. It never loads the page
that originally raised the dialog.

Then the other half: what the user asks for on purpose must work. A second view is sent to
a LAN address the way the core does it when the user types one (the `allow_local_network`
port, then the navigation). The address used (10.0.0.1) is a private one that is routed, not
on this Mac's own network, so reaching for it raises no dialog; the run only looks for the
connection attempt. Sent back to the web, the view is guarded again.

usage: lan_probe.py <path to Eos.app>
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (shared helpers; smoke.APP comes from the same argv)

OUT = os.path.join(smoke.DATA, "shell-out", "lan-probe")
SHELL_DATA = os.path.join(OUT, "data")
smoke.SHELL_DATA = SHELL_DATA

PROBE = r"""
(async () => {
  const out = {};
  out.webrtc = await new Promise((resolve) => {
    const candidates = [];
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: [] }); } catch (e) { return resolve({ error: String(e) }); }
    pc.createDataChannel("probe");
    pc.onicecandidate = (e) => { if (e.candidate) candidates.push(e.candidate.candidate); else resolve({ candidates }); };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => resolve({ error: String(e) }));
    setTimeout(() => resolve({ candidates, timedOut: true }), 4000);
  });
  const timed = async (f) => { const t0 = performance.now(); try { return { result: await f(), ms: Math.round(performance.now() - t0) }; } catch (e) { return { error: String(e), ms: Math.round(performance.now() - t0) }; } };
  out.presentation = await timed(async () => {
    if (!window.PresentationRequest) return "no API";
    const a = await Promise.race([new PresentationRequest(["https://example.com/receiver"]).getAvailability(), new Promise((r) => setTimeout(() => r({ value: "pending" }), 2500))]);
    return String(a.value);
  });
  out.remotePlayback = await timed(async () => {
    const v = document.createElement("video");
    if (!v.remote) return "no API";
    return await Promise.race([v.remote.watchAvailability(() => {}).then(() => "watching", (e) => "refused: " + e.name), new Promise((r) => setTimeout(() => r("pending"), 1500))]);
  });
  out.fetch = {};
  for (const url of ["https://192.168.1.1/", "https://10.0.0.1/", "http://192.168.1.1/", "https://probe-device.local/", "https://169.254.1.1/"]) {
    out.fetch[url] = await timed(async () => { await Promise.race([fetch(url, { mode: "no-cors", cache: "no-store" }), new Promise((_, r) => setTimeout(() => r(new Error("no answer in 3 s")), 3000))]); return "answered"; });
  }
  out.image = await timed(() => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("loaded"); i.onerror = () => resolve("error"); i.src = "http://192.168.1.1/probe.png"; setTimeout(() => resolve("pending"), 3000); }));
  out.webSocket = await timed(() => new Promise((resolve) => { let ws; try { ws = new WebSocket("wss://192.168.1.1/"); } catch (e) { return resolve("threw: " + e.name); } ws.onopen = () => resolve("open"); ws.onerror = () => resolve("error"); setTimeout(() => resolve("pending"), 3000); }));
  return out;
})()
"""

USER_LAN_HOST, USER_LAN_PORT = "10.0.0.1", "81"

WINDOWS = r"""
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list { print((w[kCGWindowOwnerName as String] as? String) ?? "?") }
"""


def window_owners():
    """Owner names of the windows on screen (names only; no titles, no content)."""
    r = subprocess.run(["swift", "-e", WINDOWS], capture_output=True, text=True, timeout=120)
    return sorted(set(r.stdout.split("\n")) - {""})


def app_pids():
    r = subprocess.run(["pgrep", "-f", smoke.APP + "/Contents"], capture_output=True, text=True)
    return [p for p in r.stdout.split() if p.isdigit()]


def sockets(pids):
    """Internet sockets of the app's processes: (protocol, name) pairs."""
    if not pids:
        return set()
    r = subprocess.run(["lsof", "-nP", "-i", "-a", "-p", ",".join(pids), "-Fn", "-FP"], capture_output=True, text=True)
    found, proto = set(), "?"
    for line in r.stdout.split("\n"):
        if line.startswith("P"):
            proto = line[1:]
        elif line.startswith("n"):
            found.add((proto, line[1:]))
    return found


def is_local(name):
    """Whether a socket name shows local-network traffic: mDNS, SSDP, or a LAN peer."""
    peer = name.split("->")[-1]
    host = peer.rsplit(":", 1)[0].strip("[]")
    port = peer.rsplit(":", 1)[-1]
    if port in ("5353", "1900"):
        return True
    return host.startswith(("192.168.", "10.", "169.254.", "224.", "239.")) or any(host.startswith(f"172.{n}.") for n in range(16, 32))


def main():
    if not os.path.isfile(smoke.BIN):
        print(__doc__)
        return 2
    subprocess.run([os.path.join(smoke.HOST, "scripts", "daemon.sh"), "start"], check=True, capture_output=True)
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)
    probe = {"cdp": {"view": "p", "method": "Runtime.evaluate", "params": {"expression": PROBE, "returnByValue": True, "awaitPromise": True}}}
    user_probe = {"cdp": {"view": "u", "method": "Runtime.evaluate", "params": {"expression": PROBE, "returnByValue": True, "awaitPromise": True}}}
    steps = [
        # 0-3: a third-party page probing the local network.
        {"create": {"as": "p", "profile": "lan-probe", "url": "https://example.com/"}},
        {"wait": 2500},
        {"cdp": {"view": "p", "method": "Runtime.evaluate", "params": {"expression": "location.origin", "returnByValue": True}}},
        probe,
        # 4-8: the user sends another view to a LAN address (port 81: nothing answers there).
        {"create": {"as": "u", "profile": "lan-user", "url": "https://example.com/"}},
        {"wait": 1500},
        {"allow": {"view": "u", "host": USER_LAN_HOST}},
        # Started from the page so the step returns at once: nothing answers at that address,
        # and a DevTools navigation would wait for the connection to give up. The guard does
        # not look at who started a navigation, only at whether the view was sent there.
        {"cdp": {"view": "u", "method": "Runtime.evaluate", "params": {"expression": f"location.assign('http://{USER_LAN_HOST}:{USER_LAN_PORT}/'); 'going'", "returnByValue": True}}},
        {"wait": 2500},
        # 9: meanwhile the third-party page, in its own profile, is still kept out.
        probe,
        # 10-13: the user sends the view back to the web: guarded again.
        {"allow": {"view": "u", "host": "example.com"}},
        {"cdp": {"view": "u", "method": "Page.navigate", "params": {"url": "https://example.com/"}}},
        {"wait": 2500},
        user_probe,
        {"close": "u"},
        {"close": "p"},
    ]
    steps_file, steps_out = os.path.join(OUT, "steps.json"), os.path.join(OUT, "steps-out.json")
    with open(steps_file, "w") as f:
        json.dump(steps, f)
    before = window_owners()
    env = dict(os.environ, EOS_DEV_DATA=smoke.DATA, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none", EOS_DEV_SCRIPT=steps_file, EOS_DEV_SCRIPT_OUT=steps_out)
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet"], check=True, env=env)

    # Sockets are sampled the whole time; each sample is stamped with the step that was running.
    samples, done, end = [], None, time.time() + 120
    while time.time() < end and not done:
        out = smoke.read_json(steps_out)
        step = len(out["results"]) if out else 0
        samples.append((step, sockets(app_pids())))
        done = out if out and out.get("done") else None
        time.sleep(0.2)
    after = window_owners()
    log = open(os.path.join(SHELL_DATA, "logs", "shell.log")).read() if os.path.exists(os.path.join(SHELL_DATA, "logs", "shell.log")) else ""
    smoke.ctl("--quit")

    if not smoke.check("the probe ran in the page", done and all(r["ok"] for r in done["results"]), "" if done else "no result"):
        if done:
            print([r.get("error") for r in done["results"] if not r["ok"]])
        return 1
    results = done["results"]
    origin = results[2]["value"]["result"].get("value")
    smoke.check("the page is a public https page", origin == "https://example.com", origin)

    def local_sockets(first, last):
        return sorted({s for step, found in samples if first <= step <= last for s in found if is_local(s[1])})

    def judge(label, page, steps, known=()):
        candidates = page.get("webrtc", {}).get("candidates", [])
        smoke.check(f"{label}: WebRTC offers no host candidate (no mDNS name, no LAN address)", not any(" host " in c for c in candidates), f"{len(candidates)} candidates")
        slow = {url: r for url, r in page.get("fetch", {}).items() if r.get("result") == "answered" or r.get("ms", 0) > 2500}
        smoke.check(f"{label}: no request to the local network was answered or left hanging", not slow, slow or "all refused at once")
        smoke.check(f"{label}: no image or WebSocket reached the local network", page.get("image", {}).get("result") != "loaded" and page.get("webSocket", {}).get("result") != "open")
        # `known`: attempts from before that the system has not given up on yet.
        local = [s for s in local_sockets(*steps) if s not in known]
        smoke.check(f"{label}: the app's processes opened no local-network socket", not local, local or "none")

    third_party = results[3]["value"]["result"].get("value") or {}
    print(json.dumps(third_party, indent=1, ensure_ascii=False))
    judge("a third-party page", third_party, (0, 3))

    # ---- what the user asked for
    asked = local_sockets(6, 8)
    wanted = f"->{USER_LAN_HOST}:{USER_LAN_PORT}"
    smoke.check("a LAN address the user asked for is reached for", any(wanted in s[1] for s in asked), asked or "no connection attempt seen")
    smoke.check("and only that address", all(wanted in s[1] for s in asked), asked)
    smoke.check("the shell opened that view's profile and closed it again", "its profile may reach it" in log and "guarded again" in log)
    meanwhile = results[9]["value"]["result"].get("value") or {}
    slow = {url: r for url, r in meanwhile.get("fetch", {}).items() if r.get("result") == "answered" or r.get("ms", 0) > 2500}
    smoke.check("meanwhile a third-party page in another profile is still kept out", not slow and meanwhile.get("webSocket", {}).get("result") != "open", slow or "all refused at once")
    back = results[13]["value"]["result"].get("value") or {}
    judge("the user's view, back on the web", back, (12, 15), known=asked)

    new_windows = sorted(set(after) - set(before))
    smoke.check("no system dialog window appeared", not any(o in ("UserNotificationCenter", "CoreServicesUIAgent", "SecurityAgent") for o in new_windows), new_windows or "no new window owner")
    failed = [name for name, ok in smoke.results if not ok]
    print(f"\n{len(smoke.results) - len(failed)}/{len(smoke.results)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
