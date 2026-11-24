#!/usr/bin/env python3
"""Pages in a real window: the page probe and the PDF of an issue, on the test bundle
(scripts/bundle.sh test) and private test data. Safe to run again and again.

A private copy of the data folder gets one routine whose page is the Morning Paper fixture
(crates/eos-surface/tests/morning-paper, written by crates/eos-app/examples/seed_pages.rs):
version 1 kept with one issue filled from the fixture's sample, version 2 the same design left
waiting for Eos's window. Then the bundle starts on that copy and:
  1. the waiting design is probed in the shell's hidden view at each width for each data
     set, with a picture of the page at each: the sample and the issue read well, and with
     the least data the fixture's rail (only optional parts) is found empty, so the version
     is discarded with that report;
  2. the issue prints to its export file through the shell's hidden view, A4 and Letter:
     each a real PDF on the paper asked (within 2 points: Chromium rounds A4 to inches);
  3. the window never needed to be shown for either.

Rules it keeps (see smoke.py): it never types into a page and never drives the dashboard;
the only core routes it calls are a page's reads and the issue's PDF, through the dev script.
The window opens without taking the focus; everything it started is stopped at the end, also
when it is killed. No page it loads fetches anything: the issue has no image.

usage: page_smoke.py <path to Eos.app>
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (shared helpers; smoke.APP comes from the same argv)

OUT = os.path.join(smoke.DEV_OUT, "page-smoke")
SHELL_DATA = os.path.join(OUT, "data")
smoke.SHELL_DATA = SHELL_DATA
HOME = os.path.join(OUT, "home")
STEPS = os.path.join(OUT, "steps.jsonl")
RESULTS = os.path.join(OUT, "results.jsonl")
# A4 and Letter in PDF points.
PAPER = {"a4": (595, 842), "letter": (612, 792)}


def seed():
    """The private data copy with the seeded page: its surface and issue ids."""
    subprocess.run(["cp", "-R", os.path.join(smoke.DATA, "home"), HOME], check=True)
    subprocess.run(["chmod", "-R", "go-rwx", HOME], check=True)
    made = subprocess.run(["cargo", "run", "-q", "-p", "eos-app", "--example", "seed_pages", "--", HOME],
                          cwd=os.path.dirname(smoke.HOST), capture_output=True, text=True)
    if made.returncode != 0:
        raise SystemExit("the page was not seeded: " + made.stderr.strip()[-400:])
    return json.loads(made.stdout.strip().splitlines()[-1])


class Script:
    """The dev script the run follows: one step at a time, its result read back."""

    def __init__(self):
        open(STEPS, "w").close()
        open(RESULTS, "w").close()
        self.sent = 0

    def call(self, method, path, body=None, wait_s=60):
        step = {"method": method, "path": path}
        if body is not None:
            step["body"] = body
        with open(STEPS, "a") as f:
            f.write(json.dumps({"browser": step}) + "\n")
        self.sent += 1
        lines = smoke.wait_for("the step's result", lambda: (lambda l: l if len(l) >= self.sent else None)(
            open(RESULTS).read().splitlines()), wait_s)
        if not lines:
            return {"status": None, "body": "no answer within %d s" % wait_s}
        result = json.loads(lines[self.sent - 1])
        return result.get("value") or {"status": None, "body": result.get("error")}

    def end(self):
        with open(STEPS, "a") as f:
            f.write(json.dumps({"end": None}) + "\n")


def media_box(path):
    """The first page box a PDF names, in points."""
    text = open(path, "rb").read().decode("latin-1")
    found = re.search(r"/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]", text)
    return (round(float(found[3]) - float(found[1])), round(float(found[4]) - float(found[2]))) if found else None


def checks(run):
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)
    page = seed()
    surface, issue = page["surfaceId"], page["issueId"]
    script = Script()
    env = dict(os.environ, EOS_DEV_DATA=smoke.DATA, EOS_DEV_HOME=HOME, EOS_SHELL_DATA=SHELL_DATA,
               EOS_ELECTRON_PROFILE="none", EOS_DEV_SCRIPT=STEPS, EOS_DEV_SCRIPT_OUT=RESULTS,
               EOS_DEV_SCRIPT_FOLLOW="1")
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet", "--background"],
                   check=True, env=env)
    try:
        st = smoke.wait_for("bridge", lambda: (lambda s: s if s.get("bridge") else None)(smoke.ctl("--status")), 40)
        if not smoke.check("the page run comes up, its window hidden", st and st["window"]["visible"] is False,
                           st and st.get("window")):
            return 1
        versions = f"/api/surfaces/{surface}/versions"
        settled = smoke.wait_for("the probe", lambda: (lambda r: r if r.get("status") == 200 and [
            v for v in r["body"]["versions"] if v["version"] == 2 and v["status"] != "checking"] else None)(
            script.call("GET", versions)), 90)
        second = next((v for v in (settled or {}).get("body", {}).get("versions", []) if v["version"] == 2), None)
        report = script.call("GET", f"{versions}/2").get("body") or {}
        checks_of = report.get("checks") or {}
        sets = {s.get("data"): s.get("widths", []) for s in checks_of.get("probe", [])}
        smoke.check("1. the design waiting for the window is probed, and its verdict kept",
                    second and second["status"] == ("candidate" if checks_of.get("passed") else "discarded"), second)
        widths = {name: sorted(w.get("width") for w in found) for name, found in sets.items()}
        smoke.check("... at both widths for each data set", widths and all(w == [360, 1000] for w in widths.values()), widths)
        clean = lambda name: name in sets and all(not w.get("findings") for w in sets[name])
        smoke.check("... the sample and the issue read well at both", clean("sample") and clean("issue 1"), json.dumps(checks_of)[:600])
        # The fixture's rail holds only optional parts: with the least data it is empty, and the
        # measuring script must say so.
        least = [f for w in sets.get("least data", []) for f in w.get("findings", [])]
        smoke.check("... and with the least data the empty rail is found", least and all(
            (f.get("check"), f.get("part")) == ("empty", "rail") for f in least), least)
        shots_dir = os.path.join(HOME, "surfaces", surface, "checks", "2")
        shots = [os.path.join(r, f) for r, _, fs in os.walk(shots_dir) for f in fs if f.endswith(".png")]
        smoke.check("... with a picture of the page at each", sets and len(shots) == 2 * len(sets) and all(os.path.getsize(p) > 2000 for p in shots),
                    f"{len(shots)} in {shots_dir}")

        exported = os.path.join(HOME, "surfaces", surface, "exports", f"{issue}.pdf")
        boxes = {}
        for paper in ("a4", "letter"):
            printed = script.call("POST", f"/api/surfaces/{surface}/issues/{issue}/pdf", {"paper": paper}, wait_s=40)
            body = printed.get("body") or {}
            real = os.path.isfile(exported) and open(exported, "rb").read(5) == b"%PDF-"
            boxes[paper] = media_box(exported) if real else None
            smoke.check(f"2. the issue prints to a PDF on {paper}",
                        printed.get("status") == 200 and real and body.get("bytes", 0) > 10_000
                        and body.get("bytes") == os.path.getsize(exported), printed)
        near = lambda box, paper: box is not None and all(abs(a - b) <= 2 for a, b in zip(box, PAPER[paper]))
        smoke.check("... on the paper asked", near(boxes.get("a4"), "a4") and near(boxes.get("letter"), "letter"), boxes)
        smoke.check("3. the window stayed hidden throughout", smoke.ctl("--status")["window"]["visible"] is False)
    finally:
        script.end()
        run.stop_app()
    failed = [name for name, ok in smoke.results if not ok]
    print("FAILED: " + ", ".join(failed) if failed else "all page checks passed")
    return 1 if failed else 0


def main():
    if not os.path.isfile(smoke.BIN):
        print(__doc__)
        return 2
    if smoke.ctl("--status").get("running"):
        print("an app is already running on this data folder; quit it first")
        return 2
    run = smoke.Run(max_seconds=600)
    try:
        return checks(run)
    finally:
        run.close()


if __name__ == "__main__":
    sys.exit(main())
