#!/usr/bin/env python3
"""Stops what a test run started when the run itself is gone.

A test that is interrupted cleans up after itself; one that is killed outright cannot. So
every run starts this guard, detached, and tells it what it started. The guard watches the
run's process: when it is gone (or the run outlived its time), the guard quits the app over
its own socket, ends the app's processes that are still there, and stops the isolated
daemon if the run started it. A run that ends normally stops the guard first.

Only processes this run started are ever signalled: the app the run launched (the pid its
own status names) and that app's children, each checked to still be running from the same
bundle; the daemon by the pid file daemon.sh wrote.

usage: guard.py <pid to watch> <Eos.app> <shell data folder> <stop the daemon: 0|1> <seconds>
"""
import os
import signal
import subprocess
import sys
import time

HOST = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def app_pid(app, data):
    """The pid the app running on `data` reports for itself, or None."""
    try:
        r = subprocess.run([os.path.join(app, "Contents", "MacOS", "Eos"), "--status"], env=dict(os.environ, EOS_SHELL_DATA=data),
                           capture_output=True, text=True, timeout=10)
        import json
        status = json.loads(r.stdout.strip().splitlines()[-1])
        return status.get("pid") if status.get("running") else None
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def tree(app, root):
    """`root` and its children, as long as they run from the bundle."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    pids = set()
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[2].startswith(app + "/") and root in (int(parts[0]), int(parts[1])):
            pids.add(int(parts[0]))
    return pids


def from_bundle(app, pid):
    out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    return out.strip().startswith(app + "/")


def stop_app(app, data, known):
    pid = app_pid(app, data)
    if pid:
        known |= tree(app, pid)
        subprocess.run([os.path.join(app, "Contents", "MacOS", "Eos"), "--quit"], env=dict(os.environ, EOS_SHELL_DATA=data),
                       capture_output=True, timeout=15)
    end = time.time() + 10
    while time.time() < end and any(alive(p) and from_bundle(app, p) for p in known):
        time.sleep(0.25)
    for p in known:
        if alive(p) and from_bundle(app, p):
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass


def main():
    watch, app, data, stop_daemon, seconds = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4] == "1", float(sys.argv[5])
    # A run that ends normally stops its guard: nothing is left to do then.
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    deadline = time.time() + seconds
    known = set()
    while alive(watch) and time.time() < deadline:
        pid = app_pid(app, data)
        if pid:
            known |= tree(app, pid)
        time.sleep(1.0)
    stop_app(app, data, known)
    if stop_daemon:
        subprocess.run([os.path.join(HOST, "scripts", "daemon.sh"), "stop"], capture_output=True, timeout=30)


if __name__ == "__main__":
    main()
