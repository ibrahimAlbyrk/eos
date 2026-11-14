#!/usr/bin/env python3
"""Right-clicks in the dashboard of the test bundle (scripts/bundle.sh test): the menus the
dashboard draws open, the system's own context menu does not, and one action does what it
says.

The app is launched quietly on the private data copy with the shell's probe and a followed
dev script (as tests/responsiveness.py). Over the in-process DevTools channel it sends real
right-clicks (Input.dispatchMouseEvent, button "right") to:
  1. a user message: the action bar opens at the pointer with the time, Rewind, Copy and
     Reply, and the page's `contextmenu` event ends default-prevented (no system menu);
     Copy puts the message's text on the clipboard;
  2. an assistant message: Copy and Reply, no Rewind;
  3. a chat in the sidebar: the chat's menu.
A right-click only opens a menu; the one left click goes to Copy. The clipboard's text is
put back afterwards (only its text: run this when the clipboard holds nothing else worth
keeping). Agents cannot start in a dev run anyway.

usage: context_menu_smoke.py <path to Eos.app>
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (shared helpers; smoke.APP comes from the same argv)

OUT = os.path.join(smoke.DEV_OUT, "context-menu")
SHELL_DATA = os.path.join(OUT, "data")
smoke.SHELL_DATA = SHELL_DATA
STEPS = os.path.join(OUT, "steps.jsonl")
RESULTS = os.path.join(OUT, "results.jsonl")
check = smoke.check


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
            lines = (open(RESULTS).read() if os.path.exists(RESULTS) else "").split("\n")[:-1]
            if len(lines) >= self.sent:
                return json.loads(lines[self.sent - 1])
            time.sleep(0.01)
        raise TimeoutError(f"no answer to {step}")

    def page(self, expression, wait=False):
        r = self.step({"page": {"expression": expression, "await": wait}})
        if not r["ok"]:
            raise RuntimeError(r["error"])
        return r["value"]

    def click(self, selector, text="", index=0, button="left"):
        return self.step({"click": {"selector": selector, "text": text, "index": index, "button": button}})

    def until(self, expression, seconds=5):
        return smoke.wait_for(expression, lambda: self.page(expression), seconds)


def launch():
    for path in (STEPS, RESULTS):
        if os.path.exists(path):
            os.remove(path)
    open(STEPS, "w").close()
    env = dict(os.environ, EOS_SHELL_DATA=SHELL_DATA, EOS_ELECTRON_PROFILE="none",
               EOS_DEV_SCRIPT=STEPS, EOS_DEV_SCRIPT_OUT=RESULTS, EOS_DEV_SCRIPT_FOLLOW="1", EOS_SHELL_PROBE="1",
               EOS_SHELL_PAINT_WHEN_COVERED="1")
    subprocess.run([os.path.join(smoke.HOST, "scripts", "launch.sh"), smoke.APP, "--quiet"], check=True, env=env)
    return smoke.wait_for("ready", lambda: smoke.bridge_of(smoke.ctl("--status")).get("ready"), 60)


# What every `contextmenu` event looked like once the whole page had it: registered after
# the bridge's own listeners, so it runs last.
WATCH = r"""(() => {
  if (window.__cmSeen) return true;
  window.__cmSeen = [];
  addEventListener("contextmenu", (e) => window.__cmSeen.push({ prevented: e.defaultPrevented }));
  return true;
})()"""

# The index (among the visible matches, as the click step counts them) of the last element
# whose middle is on screen.
ON_SCREEN = r"""((selector) => {
  const all = [...document.querySelectorAll(selector)].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i].getBoundingClientRect(), y = r.top + r.height / 2, x = r.left + r.width / 2;
    const top = document.elementFromPoint(x, y);
    if (y > 60 && y < innerHeight - 160 && top && all[i].contains(top) && !top.closest("a, code, .path-chip, [data-path]")) return i;
  }
  return -1;
})"""

BAR_TITLES = "[...document.querySelectorAll('.msg-actions button')].map((b) => b.title)"
CLOSE = "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true"


def right_click_row(d, selector):
    index = d.page(f"{ON_SCREEN}({json.dumps(selector)})")
    if index is None or index < 0:
        return None, "no row of this kind on screen"
    seen = d.page("window.__cmSeen.length")
    r = d.click(selector, "", index, button="right")
    if not r["ok"]:
        return None, r["error"]
    d.until(f"window.__cmSeen.length > {seen}")
    return index, d.page(f"window.__cmSeen.slice({seen})")


def open_a_chat_with_both(d):
    """Clicks through the sidebar's chats until one shows a user and an assistant message."""
    both = "document.querySelector('.msg-row.right') && document.querySelector('.msg-row:not(.right)') ? true : false"
    for i in range(12):
        if d.until(both, 4):
            return True
        if not d.click("div.agents-row", "", i)["ok"]:
            return False
        time.sleep(1.5)
    return False


def main():
    if not os.path.isfile(smoke.BIN):
        print(__doc__)
        return 2
    if smoke.ctl("--status").get("running"):
        print("an app is already running on this data folder; quit it first")
        return 2
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(SHELL_DATA)
    run = smoke.Run(max_seconds=600)
    clipboard = subprocess.run(["pbpaste"], capture_output=True).stdout
    try:
        if not check("the dashboard is ready", launch()):
            return 1
        d = Driver()
        time.sleep(2)
        d.page(WATCH)
        if not check("a chat with a user and an assistant message is open", open_a_chat_with_both(d)):
            return 1

        # 1. a user message
        index, seen = right_click_row(d, ".msg-row.right")
        check("a right-click reaches a user message", index is not None, seen if index is None else "")
        if index is not None:
            check("the system's context menu stays shut (contextmenu ends default-prevented)",
                  seen and all(e["prevented"] for e in seen), seen)
            opened = d.until("document.querySelector('.msg-actions') ? true : false")
            check("the message's action bar opens", opened)
            titles = d.page(BAR_TITLES) if opened else []
            check("its items: the time, Rewind, Copy, Reply",
                  d.page("!!document.querySelector('.msg-actions .msg-time')") and len(titles) == 3
                  and titles[0] in ("Rewind to here", "Agent is busy") and titles[1:] == ["Copy", "Reply"], titles)
            expected = d.page(
                f"[...document.querySelectorAll('.msg-row.right')].filter((el) => {{ const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }})[{index}].innerText")
            d.step({"focus": True})
            subprocess.run(["pbcopy"], input=b"context-menu-smoke: before copy", check=True)
            clicked = d.click(".msg-actions button", "Copy")
            check("Copy can be clicked", clicked["ok"], clicked.get("error", ""))
            copied = smoke.wait_for("clipboard", lambda: (lambda t: t if t != "context-menu-smoke: before copy" else None)(
                subprocess.run(["pbpaste"], capture_output=True, text=True).stdout), 5) or ""
            norm = lambda s: " ".join((s or "").split())
            # The clipboard gets the message as written; the row shows mentions and paths as
            # chips, so only the opening words are compared.
            check("Copy puts the message's text on the clipboard",
                  copied and norm(expected).startswith(norm(copied)[:16]), f"{norm(copied)[:40]!r} vs {norm(expected)[:40]!r}")
            d.step({"focus": False})
            d.until("document.querySelector('.msg-actions') ? false : true", 3)

        # 2. an assistant message
        index, seen = right_click_row(d, ".msg-row:not(.right)")
        check("a right-click reaches an assistant message", index is not None, seen if index is None else "")
        if index is not None:
            opened = d.until("document.querySelector('.msg-actions') ? true : false")
            titles = d.page(BAR_TITLES) if opened else []
            check("its bar offers Copy and Reply, no Rewind", titles in (["Copy", "Reply"], ["Copy"]), titles)
            check("the system's context menu stays shut there too", seen and all(e["prevented"] for e in seen), seen)
            d.page(CLOSE)
            check("Escape closes the bar", d.until("document.querySelector('.msg-actions') ? false : true", 3))

        # 3. a chat in the sidebar
        seen_before = d.page("window.__cmSeen.length")
        r = d.click("div.agents-row", "", 0, button="right")
        check("a right-click reaches a chat in the sidebar", r["ok"], r.get("error", ""))
        if r["ok"]:
            check("the chat's menu opens", d.until("document.querySelector('.ctx-menu') ? true : false"))
            check("no system menu over the sidebar", all(e["prevented"] for e in d.page(f"window.__cmSeen.slice({seen_before})")))
            d.page(CLOSE)
        # 4. the cause, shown: the refusal the bridge used to make before the page saw the
        # event (a capture listener on the window) leaves the message's bar shut.
        d.page("window.__cmOld = (e) => e.preventDefault(), addEventListener('contextmenu', window.__cmOld, true), true")
        index, seen = right_click_row(d, ".msg-row.right")
        shut = index is not None and not d.until("document.querySelector('.msg-actions') ? true : false", 1.5)
        check("with the old capture-phase refusal the bar stays shut (the regression this run guards)", shut)
        d.page("removeEventListener('contextmenu', window.__cmOld, true), true")
        failed = [name for name, ok in smoke.results if not ok]
        print("context menu: " + ("FAIL: " + "; ".join(failed) if failed else f"ok, {len(smoke.results)} checks"))
        return 1 if failed else 0
    finally:
        subprocess.run(["pbcopy"], input=clipboard)
        run.close()


if __name__ == "__main__":
    sys.exit(main())
