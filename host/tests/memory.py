#!/usr/bin/env python3
"""How much memory the bundled app uses with the dashboard open, measured the way the shell
memory study measured it: `phys_footprint` of every process of the app (footprint(1)), a
fixed time after the dashboard is ready, the window painting, a fresh shell profile per run.

  memory.py <Eos.app> [--runs 5] [--wait 40] [--label NAME] [--network-in-process]
            [--no-core] [--covered] [--closed] [--vmmap]
  memory.py <Eos.app> --idle [--runs 1] [--wait 600] [--label NAME]

  --network-in-process  Chromium's network service inside the browser process (the setting)
  --no-core             the shell alone, without the Rust core in process
  --covered             let Chromium stop painting when other windows cover the app's
  --closed              the window hidden and the dashboard's view released (after a
                        shortened release time); measured `--wait` seconds after the release
  --vmmap               on the last run, how much of the CEF framework's constant data is
                        dirty in the dashboard's renderer (clean when the framework is
                        mapped at launch, about 12 MB when it is dlopen()ed)
  --idle                the idle cost (`idle_run`): 20 routines armed on a data copy of
                        their own, the window hidden and the dashboard's view released, the
                        meaning model loaded; `--wait` seconds of nothing, measured from the
                        first minute after the release

  MEM_CHAT   the name of the chat to have open (default: the first top-level chat). The name
             is private data: it is read from the environment and never written anywhere.

Rules it keeps (see smoke.py): it never types into a page and never drives the dashboard.
The chat is opened by restoring a layout through the storage carry-over; which chat the page
then loaded is read from the app's own request log. The window opens without taking the
focus and with audio muted. Results go to the private output folder, never into git.
"""
import ctypes
import json
import os
import re
import statistics
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (shared helpers; smoke.APP comes from the same argv)

OUT = os.path.join(smoke.DEV_OUT, "memory")
SHELL_DATA = os.path.join(OUT, "data")
smoke.SHELL_DATA = SHELL_DATA
RUN = None
WINDOW = {"x": 120, "y": 80, "width": 1280, "height": 820, "maximized": False, "fullscreen": False}


def flag(name):
    return name in sys.argv


def option(name, default):
    return type(default)(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def processes():
    """The app's processes: (pid, kind) of everything running from the bundle."""
    rows = []
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    for line in out.splitlines():
        pid, _, command = line.strip().partition(" ")
        if not command.startswith(smoke.APP + "/"):
            continue
        kind = "browser"
        m = re.search(r"--type=([a-z-]+)", command)
        if m:
            kind = {"gpu-process": "gpu"}.get(m.group(1), m.group(1))
        m = re.search(r"--utility-sub-type=([A-Za-z_.]+)", command)
        if m:
            name = m.group(1).split(".")[-1]
            kind = {"NetworkService": "network", "StorageService": "storage"}.get(name, "utility:" + name)
        rows.append((int(pid), kind))
    return rows


def footprints(pids):
    """phys_footprint per pid in MB."""
    path = os.path.join(OUT, "footprint.json")
    if os.path.exists(path):
        os.remove(path)
    subprocess.run(["footprint", "-j", path, *map(str, pids)], capture_output=True, text=True)
    try:
        with open(path) as f:
            return {int(p["pid"]): p["footprint"] / 2**20 for p in json.load(f).get("processes", [])}
    except (OSError, ValueError, KeyError):
        return {}


def framework_constants(pid):
    """Dirty and swapped MB of the CEF framework's __DATA_CONST in one process."""
    out = subprocess.run(["vmmap", str(pid)], capture_output=True, text=True).stdout
    dirty = swapped = 0.0
    unit = {"K": 1 / 1024, "M": 1.0, "G": 1024.0}
    for line in out.splitlines():
        if not line.startswith("__DATA_CONST") or "Chromium Embedded Framework" not in line:
            continue
        # __DATA_CONST  start-end  [ vsize  rsdnt  dirty  swap] perms …
        m = re.search(r"\[\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*\]", line)
        if m:
            size = lambda s: float(s[:-1]) * unit.get(s[-1], 0.0) if s[-1] in unit else 0.0  # noqa: E731
            dirty += size(m.group(3))
            swapped += size(m.group(4))
    return {"dirtyMB": round(dirty, 2), "swappedMB": round(swapped, 2)}


def prepare(chat):
    """A fresh shell profile whose first launch restores one chat, with the window's frame set."""
    subprocess.run(["rm", "-rf", SHELL_DATA], check=True)
    os.makedirs(SHELL_DATA)
    with open(os.path.join(SHELL_DATA, "window.json"), "w") as f:
        json.dump(WINDOW, f)
    electron = os.path.join(OUT, "electron-profile")
    if not os.path.isdir(electron):
        layout = {
            "cm:selectedId": chat,
            "cm:paneTree": json.dumps({"t": "leaf", "id": "p1_mem", "agentId": chat}),
            "cm:paneFocusedLeaf": "p1_mem",
            "cm:activeView": "agents",
            "cm:sideCollapsed": "0",
        }
        seed = os.path.join(OUT, "layout.json")
        with open(seed, "w") as f:
            json.dump(layout, f)
        made = subprocess.run(
            ["bash", "-c", f'source "{smoke.HOST}/scripts/env.sh" && cargo run -q --manifest-path "{smoke.HOST}/../Cargo.toml" -p eos-bridge --example seed_local_storage -- "{electron}" "{seed}"'],
            capture_output=True, text=True)
        if made.returncode != 0:
            raise SystemExit("no layout to restore: " + made.stderr.strip()[-300:])
    return electron


def stop_app():
    RUN.stop_app()


def one_run(chat, wait, env_extra, vmmap, closed):
    electron = prepare(chat)
    log = os.path.join(smoke.DEV_OUT, "app.err")
    if os.path.exists(log):
        os.remove(log)
    env = dict(os.environ, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE=electron, **env_extra)
    steps = os.path.join(OUT, "steps.jsonl")
    if closed:
        # The window is hidden through a followed dev script once the dashboard is ready.
        open(steps, "w").close()
        env.update(EOS_DEV_SCRIPT=steps, EOS_DEV_SCRIPT_OUT=os.path.join(OUT, "steps-out.jsonl"),
                   EOS_DEV_SCRIPT_FOLLOW="1", EOS_DEV_DASHBOARD_RELEASE_MS="5000")
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet"], check=True, env=env)
    st = smoke.wait_for("ready", lambda: (lambda s: s if smoke.bridge_of(s).get("ready") else None)(smoke.ctl("--status")), 60)
    if not st:
        stop_app()
        return {"void": "the dashboard did not become ready"}
    if closed:
        # Long enough for the page to ask for the restored chat, as an open run does.
        time.sleep(10)
        with open(steps, "a") as f:
            f.write(json.dumps({"hide": None}) + "\n")
        if not smoke.wait_for("released", lambda: smoke.ctl("--status").get("dashboard") == "released", 40):
            stop_app()
            return {"void": "the dashboard's view was not released"}
    time.sleep(wait)
    rows = processes()
    fp = footprints([pid for pid, _ in rows])
    run = {"procs": len(rows), "by": {}, "load1": round(os.getloadavg()[0], 1), "readyMs": smoke.bridge_of(st).get("readyAfterLaunchMs")}
    renderers = sorted((fp.get(pid, 0.0), pid) for pid, kind in rows if kind == "renderer")
    for pid, kind in rows:
        # The dashboard's renderer is the big one; another one is Chromium's warm spare.
        if kind == "renderer" and renderers and pid != renderers[-1][1]:
            kind = "spare-renderer"
        run["by"][kind] = round(run["by"].get(kind, 0.0) + fp.get(pid, 0.0), 1)
    run["total"] = round(sum(run["by"].values()), 1)
    if vmmap and renderers:
        run["frameworkConstants"] = framework_constants(renderers[-1][1])
    # Read after the numbers: is the app still whole, and did the page load the chat it was
    # told to and no other?
    after = smoke.ctl("--status")
    try:
        with open(log) as f:
            text = f.read()
    except OSError:
        text = ""
    # The chat's first page comes in the boot snapshot (`/api/boot?focus=…`, whose query the
    # log leaves out); the routes the page then asks for that chat name it.
    opened = set(re.findall(r"path=/workers/([^/\s]+)/", text))
    if len(fp) != len(rows) or not after.get("running") or after.get("pid") != st.get("pid"):
        run["void"] = "a process of the app went away"
    elif opened != {chat}:
        run["void"] = f"the page loaded {len(opened)} chats, expected exactly the one restored"
    elif after.get("window", {}).get("visible") is not (not closed):
        run["void"] = "the window was hidden" if not closed else "the window was shown"
    elif closed and after.get("dashboard") != "released":
        run["void"] = "the dashboard's view came back"
    if closed:
        with open(steps, "a") as f:
            f.write(json.dumps({"end": None}) + "\n")
    stop_app()
    return run


# ---- the idle cost (09 §9.1, XC-08)

IDLE_ROUTINES = 20
# After the release, before the first sample: the release's own work settles.
IDLE_SETTLE = 60
# §9.1: no loop of the core wakes more than once a minute while nothing happens. A timer
# shorter than that may fire this often in the whole window (a debounce after the release).
SHORT_WAKES_ALLOWED = 2


class RUsage(ctypes.Structure):
    """rusage_info_v2 (<sys/resource.h>): times in Mach absolute units."""
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
        "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime", "child_user_time",
        "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups", "child_pageins",
        "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten")]


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


LIBSYSTEM = ctypes.CDLL("/usr/lib/libSystem.B.dylib")


def usage(pids):
    """Per pid: (CPU seconds, wake-ups) so far, from proc_pid_rusage."""
    base = Timebase()
    LIBSYSTEM.mach_timebase_info(ctypes.byref(base))
    out = {}
    for pid in pids:
        r = RUsage()
        if LIBSYSTEM.proc_pid_rusage(pid, 2, ctypes.byref(r)) == 0:
            cpu = (r.user_time + r.system_time) * base.numer / base.denom / 1e9
            out[pid] = (cpu, r.pkg_idle_wkups + r.interrupt_wkups)
    return out


def core_wakes():
    """The core's timer wakes by wait length in seconds (eos-app's WakeCounter)."""
    wakes = (smoke.bridge_of(smoke.ctl("--status")).get("core") or {}).get("wakes") or {}
    return {int(k): v for k, v in (wakes.get("bySeconds") or {}).items()}


def kinds_of(rows, fp):
    """Each pid's kind, the dashboard's renderer told apart from a spare one by size."""
    renderers = sorted((fp.get(pid, 0.0), pid) for pid, kind in rows if kind == "renderer")
    return {pid: ("spare-renderer" if kind == "renderer" and pid != renderers[-1][1] else kind) for pid, kind in rows}


def idle_run(home, wait):
    subprocess.run(["rm", "-rf", SHELL_DATA], check=True)
    os.makedirs(SHELL_DATA)
    log = os.path.join(smoke.DEV_OUT, "app.err")
    if os.path.exists(log):
        os.remove(log)
    steps = os.path.join(OUT, "steps.jsonl")
    open(steps, "w").close()
    env = dict(os.environ, EOS_DEV_HOME=home, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none",
               EOS_LOG="warn,eos=info,eos_mod_memory=info", EOS_DEV_SCRIPT=steps,
               EOS_DEV_SCRIPT_OUT=os.path.join(OUT, "steps-out.jsonl"), EOS_DEV_SCRIPT_FOLLOW="1",
               EOS_DEV_DASHBOARD_RELEASE_MS="5000")
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet"], check=True, env=env)
    st = smoke.wait_for("ready", lambda: (lambda s: s if smoke.bridge_of(s).get("ready") else None)(smoke.ctl("--status")), 60)
    if not st:
        stop_app()
        return {"void": "the dashboard did not become ready"}
    time.sleep(10)
    with open(steps, "a") as f:
        f.write(json.dumps({"hide": None}) + "\n")
    if not smoke.wait_for("released", lambda: smoke.ctl("--status").get("dashboard") == "released", 40):
        stop_app()
        return {"void": "the dashboard's view was not released"}
    # A followed script looks for new steps every few milliseconds: ended here, so the
    # measurement counts the app and not the script.
    with open(steps, "a") as f:
        f.write(json.dumps({"end": None}) + "\n")
    time.sleep(IDLE_SETTLE)
    rows = processes()
    began, wakes0, use0 = time.time(), core_wakes(), usage([pid for pid, _ in rows])
    time.sleep(wait)
    elapsed, wakes1 = time.time() - began, core_wakes()
    rows = processes()
    use1, fp = usage([pid for pid, _ in rows]), footprints([pid for pid, _ in rows])
    kinds = kinds_of(rows, fp)
    run = {"seconds": round(elapsed), "by": {}, "load1": round(os.getloadavg()[0], 1)}
    for pid, kind in kinds.items():
        part = run["by"].setdefault(kind, {"mb": 0.0, "cpuPct": 0.0, "wakesPerS": 0.0})
        part["mb"] = round(part["mb"] + fp.get(pid, 0.0), 1)
        if pid in use0 and pid in use1:
            part["cpuPct"] = round(part["cpuPct"] + (use1[pid][0] - use0[pid][0]) / elapsed * 100, 2)
            part["wakesPerS"] = round(part["wakesPerS"] + (use1[pid][1] - use0[pid][1]) / elapsed, 1)
    run["total"] = round(sum(p["mb"] for p in run["by"].values()), 1)
    by = {k: wakes1.get(k, 0) - wakes0.get(k, 0) for k in sorted(set(wakes0) | set(wakes1))}
    run["coreWakes"] = {str(k): n for k, n in by.items() if n}
    # Lengths past the counter's kept ones (-1) are unknown: counted as short.
    run["shortWakes"] = sum(n for k, n in by.items() if k < 60)
    after = smoke.ctl("--status")
    try:
        with open(log) as f:
            text = f.read()
    except OSError:
        text = ""
    if not wakes1:
        run["void"] = "the status shows no wake counts"
    elif "memory: the meaning model is loaded" not in text:
        run["void"] = "the meaning model did not load"
    elif len(fp) != len(rows) or not after.get("running") or after.get("pid") != st.get("pid"):
        run["void"] = "a process of the app went away"
    elif after.get("dashboard") != "released":
        run["void"] = "the dashboard's view came back"
    stop_app()
    return run


def measure_idle(runs, wait, label):
    home = os.path.join(OUT, "idle-home")
    subprocess.run(["rm", "-rf", home], check=True)
    smoke.arm(home, IDLE_ROUTINES)
    try:
        results = []
        for i in range(runs):
            run = idle_run(home, wait)
            results.append(run)
            if "void" in run:
                print(f"run {i + 1}: void: {run['void']}", flush=True)
                continue
            minutes = run["seconds"] / 60
            print(f"run {i + 1}: {run['total']:.0f} MB, core timers woke {sum(int(n) for n in run['coreWakes'].values())} "
                  f"times in {minutes:.1f} min {run['coreWakes']}, load {run['load1']}", flush=True)
            for kind, part in sorted(run["by"].items()):
                print(f"  {kind:<16} {part['mb']:>7.1f} MB  {part['cpuPct']:>6.2f} % CPU  {part['wakesPerS']:>7.1f} wake-ups/s")
        with open(os.path.join(OUT, "results", label + ".json"), "w") as f:
            json.dump({"label": label, "idle": True, "routines": IDLE_ROUTINES, "wait": wait, "runs": results}, f, indent=1)
    finally:
        subprocess.run(["rm", "-rf", home], check=True)
    good = [r for r in results if "void" not in r]
    if not good:
        print("no run counted")
        return 1
    over = [r["shortWakes"] for r in good if r["shortWakes"] > SHORT_WAKES_ALLOWED]
    print(f"\n{label}: n={len(good)} of {len(results)}, {IDLE_ROUTINES} routines armed, window released, "
          f"meaning model loaded")
    print(f"  timers under 60 s woke the core {max(r['shortWakes'] for r in good)} times at most "
          f"(allowed {SHORT_WAKES_ALLOWED}): {'over the bound' if over else 'within the bound'}")
    return 1 if over else 0


def spread(values):
    return f"{statistics.median(values):.0f} ({min(values):.0f}–{max(values):.0f})"


def main():
    if not os.path.isfile(smoke.BIN):
        print(__doc__)
        return 2
    idle = flag("--idle")
    runs, wait = option("--runs", 1 if idle else 5), option("--wait", 600 if idle else 40)
    label = option("--label", "default")
    os.makedirs(os.path.join(OUT, "results"), exist_ok=True)
    if smoke.ctl("--status").get("running"):
        print("an app is already running on the memory data folder; quit it first")
        return 2
    global RUN
    RUN = smoke.Run(max_seconds=runs * (wait + 240) + 600)
    try:
        return measure_idle(runs, wait, label) if idle else measure(runs, wait, label)
    finally:
        RUN.close()


def measure(runs, wait, label):
    roots = smoke.chats()
    wanted = os.environ.get("MEM_CHAT")
    named = [w for w in roots if wanted and (w.get("name") or "").strip() == wanted]
    if not roots or (wanted and not named):
        print("the data copy does not hold the chat to open")
        return 1
    chat = (named or roots)[0]["id"]

    env_extra = {"EOS_LOG": "warn,eos::bridge=debug"}
    if not flag("--covered"):
        env_extra["EOS_SHELL_PAINT_WHEN_COVERED"] = "1"
    if flag("--network-in-process"):
        env_extra["EOS_SHELL_NETWORK_IN_PROCESS"] = "1"
    if flag("--no-core"):
        env_extra["EOS_HOME"] = ""
    results = []
    for i in range(runs):
        run = one_run(chat, wait, env_extra, flag("--vmmap") and i == runs - 1, flag("--closed"))
        results.append(run)
        print(f"run {i + 1}: " + (f"void: {run['void']}" if "void" in run else f"{run['total']:.0f} MB in {run['procs']} processes {run['by']} load {run['load1']}"), flush=True)
    with open(os.path.join(OUT, "results", label + ".json"), "w") as f:
        json.dump({"label": label, "wait": wait, "runs": results}, f, indent=1)
    good = [r for r in results if "void" not in r]
    if not good:
        print("no run counted")
        return 1
    kinds = sorted({k for r in good for k in r["by"]})
    print(f"\n{label}: n={len(good)} of {len(results)}, {wait} s after ready")
    print(f"  total      {spread([r['total'] for r in good])} MB")
    print(f"  processes  {spread([r['procs'] for r in good])}")
    for kind in kinds:
        print(f"  {kind:<10} {spread([r['by'].get(kind, 0.0) for r in good])}")
    constants = next((r["frameworkConstants"] for r in reversed(good) if "frameworkConstants" in r), None)
    if constants:
        print(f"  the framework's constant data in the renderer: {constants['dirtyMB']} MB dirty, {constants['swappedMB']} MB swapped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
