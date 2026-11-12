#!/usr/bin/env python3
"""How quickly the dashboard answers a click, in the bundled app. A gate: it fails when an
interaction is over budget.

The app is launched quietly on the private data copy with the shell's measuring probe
(`EOS_SHELL_PROBE`) and a followed dev script (`EOS_DEV_SCRIPT_FOLLOW`). Over the in-process
DevTools channel the run clicks harmless controls of the DASHBOARD with trusted mouse events
(side panel and its tabs, the new-tab launcher, the model picker, Settings and its
sections, chats), first with nothing in the browser panel, then with a page on screen in
it, each click `--reps` times (20). Per click it records:

  paint    from the press to the frame that showed the result (the later of a frame probe
           and Chromium's event timing)
  frame    the longest gap between two frames while the click settled
  task     the page's longest task or long animation frame, with the scripts in it
  ui       the shell's UI thread: how late a task posted every 4 ms ran, when over 16 ms
  probe    how long the core held a trivial request (`/health`) sent during the click (its
           whole trip through the transport is shown too)
  requests what the click asked for: path, duration, which side answered (Server-Timing:
           rust | daemon) and that side's time to the head

Budgets (see `report`): paint p95 < 100 ms; probe < 50 ms in the core; no UI-thread stall over 16 ms
while a bridge or browser-view call is in flight; no long frame over 50 ms running the
bridge script. The dashboard's own long tasks and the other stalls are shown, not gated.

A click is never sent to a control that takes text, submits a form, or reads as sending,
running, approving or deleting (the dev script refuses those itself); there is no keyboard
input at all. Agents cannot start in a dev run anyway. `--trace file` also writes a Chromium
trace of every process over the run.

usage: responsiveness.py <path to Eos.app> [--reps N] [--scenario plain,browser] [--json out.json] [--trace trace.json]
"""
import json
import os
import statistics
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (shared helpers; smoke.APP comes from the same argv)

OUT = os.path.join(smoke.DEV_OUT, "responsiveness")
SHELL_DATA = os.path.join(OUT, "data")
smoke.SHELL_DATA = SHELL_DATA
STEPS = os.path.join(OUT, "steps.jsonl")
RESULTS = os.path.join(OUT, "results.jsonl")

BUDGET = {"paint_p95": 100, "probe": 50, "ui": 16, "task": 50}
# `--trace file`: a Chromium trace of the run (every process), for finding where time goes.
TRACE_CATEGORIES = "toplevel,devtools.timeline,disabled-by-default-devtools.timeline,input,benchmark,latencyInfo,cc,viz,ui,browser,blink.user_timing"


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv[:-1] else default


REPS = int(arg("--reps", "20"))
SCENARIOS = (arg("--scenario") or "plain,browser").split(",")

# Installed once in the dashboard: observers and a frame clock. Read-only: it changes nothing
# the page does.
PROBE = r"""(() => {
  if (window.__rsp) return true;
  const R = window.__rsp = { lt: [], loaf: [], ev: [], frames: [], clicks: [], err: [] };
  try { performance.setResourceTimingBufferSize(100000); } catch (e) {}
  const watch = (type, f, opts = {}) => {
    try { new PerformanceObserver((list) => list.getEntries().forEach(f)).observe({ type, ...opts }); }
    catch (e) { R.err.push(type + ": " + e.message); }
  };
  watch("longtask", (e) => R.lt.push({ s: e.startTime, d: e.duration }));
  watch("long-animation-frame", (e) => R.loaf.push({
    s: e.startTime, d: e.duration, block: e.blockingDuration, render: e.renderStart, layout: e.styleAndLayoutStart,
    scripts: e.scripts.map((x) => ({ d: Math.round(x.duration), forced: Math.round(x.forcedStyleAndLayoutDuration),
      invoker: String(x.invoker).slice(0, 80), src: (x.sourceURL || "").split("/").pop(), fn: x.sourceFunctionName, at: x.sourceCharPosition })),
  }));
  // Chromium's own measure of a click: from the input to the frame that showed its result.
  watch("event", (e) => { if (e.interactionId) R.ev.push({ n: e.name, s: e.startTime, d: e.duration }); }, { durationThreshold: 16 });
  const tick = (t) => { R.frames.push(t); if (R.frames.length > 8000) R.frames.splice(0, 4000); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  // Which side answered a request: the dev run's Server-Timing header, which Chromium keeps
  // out of resource timing for this origin, so it is read from the response itself.
  R.sides = new Map();
  const fetch0 = window.fetch;
  window.fetch = function (input, init) {
    const answer = fetch0.apply(this, arguments);
    const url = new URL(typeof input === "string" ? input : input.url, location.href).href;
    answer.then((r) => { if (R.sides.size > 2000) R.sides.clear(); R.sides.set(url, r.headers.get("server-timing") || ""); }, () => {});
    return answer;
  };
  addEventListener("pointerdown", (e) => { R.down = e.timeStamp; }, true);
  // The first frame after the click's handlers: a frame callback, then a task after it.
  addEventListener("click", () => {
    const t0 = R.down;
    requestAnimationFrame(() => setTimeout(() => R.clicks.push({ t0, paint: performance.now() }), 0));
  }, true);
  R.mark = () => { R.t = performance.now(); R.clicks = []; R.lt = []; R.loaf = []; R.ev = []; performance.clearResourceTimings(); return { t: R.t, origin: performance.timeOrigin }; };
  // Waits until the click has painted and the page is quiet (no request and no long frame
  // for `quiet` ms), at most `most` ms, then reports the interaction.
  // A trivial request sent while the click's own requests run: how long the core made a
  // request wait that has nothing to do (its Server-Timing: from the core's door to the
  // answer), and its whole trip as the loader timed it (a busy page thread does not count).
  R.probes = 0;
  const probe = async () => {
    const url = new URL("/_core/health?probe=" + ++R.probes, location.href).href;
    try { await (await fetch(url)).text(); } catch (e) {}
    const entry = performance.getEntriesByName(url)[0];
    const core = parseFloat((R.sides.get(url) || "").split(";dur=")[1] || "0");
    return { core, trip: entry ? entry.responseEnd - entry.startTime : 0 };
  };
  R.settle = async (quiet, most) => {
    const start = R.t, until = start + most;
    const probes = [0, 30, 60].map((wait) => new Promise((r) => setTimeout(r, wait)).then(probe));
    const busy = () => Math.max(start,
      ...performance.getEntriesByType("resource").map((r) => r.responseEnd || r.startTime),
      ...R.loaf.map((l) => l.s + l.d));
    while (performance.now() < until && (!R.clicks.length || performance.now() - busy() < quiet))
      await new Promise((r) => setTimeout(r, 25));
    // Long-frame and event entries arrive a little after their frame.
    await new Promise((r) => setTimeout(r, 60));
    const waited = await Promise.all(probes);
    const end = performance.now();
    const frames = R.frames.filter((f) => f >= start - 100 && f <= end);
    let gap = 0;
    for (let i = 1; i < frames.length; i++) if (frames[i] > start) gap = Math.max(gap, frames[i] - frames[i - 1]);
    const click = R.clicks[0];
    const requests = performance.getEntriesByType("resource").filter((r) => !r.name.includes("/_core/health?probe=")).map((r) => {
      const [side, head] = (R.sides.get(r.name) || "").split(";dur=");
      return { path: r.name.replace(location.origin, "").split("?")[0], at: Math.round(r.startTime - start), ms: Math.round(r.duration),
        side: side || "", head: head ? Math.round(parseFloat(head)) : null, kind: r.initiatorType };
    });
    return {
      paint: click ? click.paint - click.t0 : null, frame: gap, settled: end - start,
      event: Math.max(0, ...R.ev.map((e) => e.d)),
      task: Math.max(0, ...R.lt.map((l) => l.d), ...R.loaf.map((l) => l.block > 0 ? l.d : 0)),
      longtasks: R.lt.map((l) => ({ at: Math.round(l.s - start), d: Math.round(l.d) })),
      loaf: R.loaf.filter((l) => l.d > 30).map((l) => ({ at: Math.round(l.s - start), d: Math.round(l.d), block: Math.round(l.block),
        render: l.render ? Math.round(l.s + l.d - l.render) : 0, layout: l.layout ? Math.round(l.s + l.d - l.layout) : 0, scripts: l.scripts.filter((x) => x.d > 5) })),
      requests, frames: frames.length, probe: Math.max(...waited.map((w) => w.core)), trip: Math.max(...waited.map((w) => w.trip)),
    };
  };
  return R.err.length ? R.err : true;
})()"""


class Driver:
    """Steps appended to the app's followed script, one result line back for each."""

    def __init__(self):
        self.sent = 0

    def step(self, step, timeout=30):
        with open(STEPS, "a") as f:
            f.write(json.dumps(step) + "\n")
        self.sent += 1
        end = time.time() + timeout
        while time.time() < end:
            # Whole lines only: the last one may still be being written.
            lines = (open(RESULTS).read() if os.path.exists(RESULTS) else "").split("\n")[:-1]
            if len(lines) >= self.sent:
                return json.loads(lines[self.sent - 1])
            time.sleep(0.005)
        raise TimeoutError(f"no answer to {step}")

    def page(self, expression, wait=False):
        r = self.step({"page": {"expression": expression, "await": wait}})
        if not r["ok"]:
            raise RuntimeError(r["error"])
        return r["value"]

    def click(self, selector, text="", index=0):
        return self.step({"click": {"selector": selector, "text": text, "index": index}})


def launch():
    for path in (STEPS, RESULTS):
        if os.path.exists(path):
            os.remove(path)
    open(STEPS, "w").close()
    env = dict(os.environ, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE=os.path.join(OUT, "electron-profile"),
               EOS_DEV_SCRIPT=STEPS, EOS_DEV_SCRIPT_OUT=RESULTS, EOS_DEV_SCRIPT_FOLLOW="1", EOS_SHELL_PROBE="1",
               EOS_SHELL_PAINT_WHEN_COVERED="1")
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet"], check=True, env=env)
    st = smoke.wait_for("ready", lambda: (lambda s: s if smoke.bridge_of(s).get("ready") else None)(smoke.ctl("--status")), 60)
    if not st:
        raise RuntimeError("the dashboard did not reach ready")
    return st


def seed_layout(chat):
    """The layout to restore, through the storage carry-over: one chat open, its side panel
    closed with the Files and Browser tabs in it."""
    layout = {
        "cm:selectedId": chat,
        "cm:paneTree": json.dumps({"t": "leaf", "id": "p1_rsp", "agentId": chat}),
        "cm:paneFocusedLeaf": "p1_rsp",
        "cm:sidePanels": json.dumps({"p1_rsp": {"open": False, "openTabs": ["files", "browser"], "activeTab": "files", "tabHistory": ["files"], "windowWidth": None}}),
        "cm:sideCollapsed": "0",
    }
    seed_json = os.path.join(OUT, "layout.json")
    with open(seed_json, "w") as f:
        json.dump(layout, f)
    electron = os.path.join(OUT, "electron-profile")
    seeded = subprocess.run(
        ["bash", "-c", f'source "{smoke.HOST}/scripts/env.sh" && cargo run -q --manifest-path "{smoke.HOST}/../Cargo.toml" -p eos-bridge --example seed_local_storage -- "{electron}" "{seed_json}"'],
        capture_output=True, text=True)
    if seeded.returncode != 0:
        raise RuntimeError("the layout was not seeded: " + seeded.stderr.strip()[-300:])



# One round: (name, selector, text, index). Each click is measured as its own interaction;
# a name that starts with "-" is a step to get somewhere and is not reported.
ROUND = [
    ("panel.open", "button.sp-toggle", "Open side panel", 0),
    ("panel.newtab", "button.sp-plus", "", 0),
    ("newtab.changes", "button.nt-tool", "Changes", 0),
    ("panel.tab", "span.sp-tab", "Files", 0),
    ("panel.tab", "span.sp-tab", "Browser", 0),
    ("panel.tab", "span.sp-tab", "Changes", 0),
    ("-panel.tab.close", "span.sp-tab-x", "", 2),
    ("panel.close", "button.sp-toggle", "Close side panel", 0),
    ("model.open", "button.model-effort-trigger", "", 0),
    ("model.close", "button.model-effort-trigger", "", 0),
    ("chat.switch", "div.agents-row", "", 1),
    ("chat.switch", "div.agents-row", "", 0),
    ("-account", "button.sb-settings__account", "", 0),
    ("settings.open", "button.acct-action", "Settings", 0),
    ("settings.section", "button.stg-nav__item", "General", 0),
    ("settings.section", "button.stg-nav__item", "Accounts", 0),
    ("settings.section", "button.stg-nav__item", "Usage", 0),
    ("settings.section", "button.stg-nav__item", "Code", 0),
    ("settings.close", "button.stg-close", "", 0),
]

# The same with a page on screen in the side panel's Browser tab: the native view over the
# dashboard is placed, hidden behind a still while a menu or modal covers it, and shown again.
PAGE = "data:text/html,<title>Panel page</title><body style='font:16px system-ui;background:%23f4efe6'><h1>Panel page</h1>" + "<p>Line of text.</p>" * 40
BROWSER_ROUND = [
    ("b.model.open", "button.model-effort-trigger", "", 0),
    ("b.model.close", "button.model-effort-trigger", "", 0),
    ("-account", "button.sb-settings__account", "", 0),
    ("b.settings.open", "button.acct-action", "Settings", 0),
    ("b.settings.close", "button.stg-close", "", 0),
    ("b.panel.tab", "span.sp-tab", "Files", 0),
    ("b.panel.tab", "span.sp-tab", "Browser", 0),
    ("b.panel.close", "button.sp-toggle", "Close side panel", 0),
    ("b.panel.open", "button.sp-toggle", "Open side panel", 0),
    ("b.chat.switch", "div.agents-row", "", 1),
    ("b.chat.switch", "div.agents-row", "", 0),
]


def measure(d, name, selector, text, index):
    mark = d.page("__rsp.mark()")
    clicked = d.click(selector, text, index)
    if not clicked["ok"]:
        return {"name": name, "error": clicked["error"]}
    record = d.page("__rsp.settle(250, 3000)", wait=True)
    stalls = d.step({"stalls": None}).get("value") or {}
    record["ui"] = max([ms for _, ms in stalls.get("stalls", [])], default=0)
    record["uiStalls"] = stalls.get("stalls", [])
    record["name"] = name
    record["start"] = mark["origin"] + mark["t"]
    return record


# What the shell or the core does for the page: a bridge, or a view the browser panel makes.
OURS = ("/_shell/", "/_core/browser/")


def bridge_stalls(record):
    """The UI-thread stalls that happened while one of our calls was in flight."""
    calls = [(record["start"] + q["at"], record["start"] + q["at"] + q["ms"]) for q in record["requests"] if q["path"].startswith(OURS)]
    return [late for at, late in record["uiStalls"] if any(begin <= at + late and at <= end for begin, end in calls)]


def our_tasks(record):
    """Long frames in which a script of ours ran: the bridge script lives in the entry document."""
    return [l["d"] for l in record["loaf"] if any(x["src"] == "index.html" for x in l["scripts"])]


def show_a_page(d):
    """The side panel open on the Browser tab with a local page in it, the view on screen."""
    for selector, text in (("button.sp-toggle", "Open side panel"), ("span.sp-tab", "Browser")):
        d.click(selector, text)
        time.sleep(0.5)
    # The chat on screen: the dashboard keeps the selection in its storage.
    chat = d.page("localStorage.getItem('cm:selectedId')")
    if not chat:
        return False
    tabs = d.step({"browser": {"method": "GET", "path": f"/browser/tabs?session={chat}", "tab": "p", "retry_ms": 15000}})
    navigated = d.step({"browser": {"method": "POST", "path": "/browser/tabs/{p}/navigate?session=" + chat, "body": {"action": "url", "url": PAGE}}})
    if not (tabs["ok"] and navigated["ok"] and navigated["value"].get("status") == 200):
        return False
    return smoke.wait_for("panel", lambda: smoke.bridge_of(smoke.ctl("--status")).get("panel", {}).get("shown"), 15)


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(round(p / 100 * (len(values) - 1))))] if values else 0


def report(records):
    """One line per interaction: median / p95 / max of each measure, and the verdict.

    Gated (the brief's budgets): the click painted within 100 ms at p95; a trivial request
    sent during the click answered by the core within 50 ms (nothing in the core made it
    wait); no UI-thread stall over 16 ms while a bridge call or a browser-view call was
    in flight; no long frame over 50 ms in which our bridge script ran. Shown, not gated:
    the page's own long frames (the dashboard's rendering, the same bundle as Electron's)
    and the UI-thread stalls with none of our calls in flight."""
    names = list(dict.fromkeys(r["name"] for r in records if not r["name"].startswith("-")))
    failed = []
    print(f"{'interaction':18} {'n':>3}  {'paint ms med/p95/max':>20}  {'frame gap':>16}  {'page task':>9}  {'ui (ours)':>10}  {'probe/trip':>10}  slowest request")
    for name in names:
        rows = [r for r in records if r["name"] == name and "error" not in r]
        errors = [r["error"] for r in records if r["name"] == name and "error" in r]
        # The later of the two ends: the frame after the handlers (our probe) and the frame
        # Chromium says showed the result (event timing, reported from 16 ms on).
        paints = [max(r["paint"], r.get("event", 0)) for r in rows if r.get("paint") is not None]
        frames = [r["frame"] for r in rows]
        task = max([r["task"] for r in rows], default=0)
        ours_task = max([t for r in rows for t in our_tasks(r)], default=0)
        ui = max([r["ui"] for r in rows], default=0)
        ours_ui = max([late for r in rows for late in bridge_stalls(r)], default=0)
        probe = max([r.get("probe", 0) for r in rows], default=0)
        trip = max([r.get("trip", 0) for r in rows], default=0)
        reqs = [q for r in rows for q in r["requests"] if q["kind"] in ("fetch", "xmlhttprequest", "other")]
        slow = max(reqs, key=lambda q: q["ms"], default=None)
        slowest = f"{slow['path']} {slow['ms']} ms ({slow['side'] or 'shell'})" if slow else "-"
        f3 = lambda v: f"{statistics.median(v):4.0f}/{pct(v, 95):4.0f}/{max(v):4.0f}" if v else "-"
        print(f"{name:18} {len(rows):3}  {f3(paints):>20}  {f3(frames):>16}  {task:9.0f}  {ui:4.0f} ({ours_ui:3.0f})  {probe:4.0f}/{trip:5.0f}  {slowest}")
        over = []
        if errors:
            over.append(f"{len(errors)} clicks failed: {errors[0]}")
        if not paints or pct(paints, 95) > BUDGET["paint_p95"]:
            over.append(f"paint p95 {pct(paints, 95):.0f} ms > {BUDGET['paint_p95']}")
        if probe > BUDGET["probe"]:
            over.append(f"the core held a trivial request {probe:.0f} ms > {BUDGET['probe']}")
        if ours_ui > BUDGET["ui"]:
            over.append(f"a {ours_ui:.0f} ms UI-thread stall during a bridge call > {BUDGET['ui']}")
        if ours_task > BUDGET["task"]:
            over.append(f"a {ours_task:.0f} ms long frame running the bridge script > {BUDGET['task']}")
        if over:
            failed.append((name, over))
    return failed


def main():
    if not os.path.isfile(smoke.BIN):
        print(__doc__)
        return 2
    if smoke.ctl("--status").get("running"):
        print("an app is already running on this data folder; quit it first")
        return 2
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)
    run = smoke.Run(max_seconds=1200)
    try:
        status, workers = smoke.daemon("/workers")
        roots = [w for w in (workers or []) if isinstance(w, dict) and not w.get("parent_id") and not w.get("archived_at")] if status == 200 else []
        if not roots:
            print("the isolated daemon lists no chats")
            return 1
        seed_layout(roots[0]["id"])
        st = launch()
        d = Driver()
        # The dashboard settles after "ready" (first lists, the stream): measure after that.
        time.sleep(3)
        installed = d.page(PROBE)
        if installed is not True:
            print("the page's observers could not all be installed:", installed)
            return 1
        d.step({"stalls": None})
        records = []
        trace = arg("--trace")
        if trace:
            started = d.step({"trace": {"start": TRACE_CATEGORIES}})
            if not started["ok"]:
                print("no trace:", started["error"])
                trace = None
        if "plain" in SCENARIOS:
            for rep in range(REPS):
                records += [measure(d, *click) for click in ROUND]
        if "browser" in SCENARIOS:
            if not show_a_page(d):
                print("no page could be put in the browser panel")
                return 1
            for rep in range(REPS):
                records += [measure(d, *click) for click in BROWSER_ROUND]
        if trace:
            print("trace:", d.step({"trace": {"stop": os.path.abspath(trace)}}, timeout=120))
        with open(arg("--json") or os.path.join(OUT, "records.json"), "w") as f:
            json.dump({"status": smoke.ctl("--status"), "records": records}, f)
        failed = report(records)
        transport = smoke.ctl("--status").get("transport", {})
        print(f"transport: {transport}; launch: {st.get('bridge', {}).get('readyInPageMs')} ms to ready in the page")
        for name, over in failed:
            print(f"OVER BUDGET {name}: " + "; ".join(over))
        print("responsiveness: " + ("FAIL" if failed else "ok, every interaction within budget"))
        return 1 if failed else 0
    finally:
        run.close()


if __name__ == "__main__":
    sys.exit(main())
