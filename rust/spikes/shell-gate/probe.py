#!/usr/bin/env python3
"""Helpers to drive the dashboard inside the gate app (trusted input over in-process CDP)."""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ctl import call, ev

SHOTS = os.environ.get("GATE_SHOTS", "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data/shell-gate-out/shots")
os.makedirs(SHOTS, exist_ok=True)

def cdp(method, view="main", timeoutMs=8000, **params):
    return call("cdp", view=view, method=method, params=params, timeoutMs=timeoutMs)

def center(js_el, view="main"):
    """js_el: a JS expression that yields an element."""
    return ev(f"(() => {{ const e = {js_el}; if (!e) return null; e.scrollIntoView({{block:'nearest'}}); const r = e.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2, r.width, r.height]; }})()", view)

def click_at(x, y, view="main"):
    for kind, buttons in (("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)):
        cdp("Input.dispatchMouseEvent", view, type=kind, x=x, y=y, button="none" if kind == "mouseMoved" else "left", buttons=buttons, clickCount=0 if kind == "mouseMoved" else 1)

def click(js_el, view="main"):
    c = center(js_el, view)
    if not c or isinstance(c, dict): return False
    click_at(c[0], c[1], view); return True

def key(k, code, vk, modifiers=0, view="main"):
    for t in ("rawKeyDown", "keyUp"):
        cdp("Input.dispatchKeyEvent", view, type=t, key=k, code=code, windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk, modifiers=modifiers)

def wait(expr, timeout=8, view="main"):
    end = time.time() + timeout
    while time.time() < end:
        if ev(expr, view) is True: return True
        time.sleep(0.1)
    return False

def shot(name, view="main", window=True):
    r = call("shot", view=view, file=f"{SHOTS}/{name}.png")
    if window:
        wn = call("info")["value"]["windowNumber"]
        subprocess.run(["screencapture", "-x", "-o", "-l", str(wn), f"{SHOTS}/{name}-window.png"])
    return r.get("ok"), r.get("error")

def text_el(selector, text):
    return f"[...document.querySelectorAll({json.dumps(selector)})].find(e => (e.textContent||'').trim().startsWith({json.dumps(text)}))"
