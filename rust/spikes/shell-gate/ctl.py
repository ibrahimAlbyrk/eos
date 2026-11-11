#!/usr/bin/env python3
"""File RPC to the running gate app.  ctl.py <op> [key=value ...]   (value parsed as JSON when it can be)
   e.g.  ctl.py eval expr='document.title'      ctl.py shot view=main file=/abs/x.png      ctl.py quit"""
import json, os, sys, time
OUT = os.environ.get("GATE_OUT", "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data/shell-gate-out/run")

def call(op, timeout=30, **kw):
    d = os.path.join(OUT, "ctl")
    name = os.path.join(d, f"{time.time_ns()}")
    with open(name + ".part", "w") as f:
        json.dump({"op": op, **kw}, f)
    os.rename(name + ".part", name + ".req")
    end = time.time() + timeout
    while time.time() < end:
        if os.path.exists(name + ".res"):
            with open(name + ".res") as f:
                r = json.load(f)
            os.remove(name + ".res")
            return r
        time.sleep(0.01)
    return {"ok": False, "error": "no answer from the app"}

def ev(expr, view="main", **kw):
    r = call("eval", expr=expr, view=view, **kw)
    return r.get("value") if r.get("ok") else {"__error": r.get("error")}

if __name__ == "__main__":
    kw = {}
    for a in sys.argv[2:]:
        k, v = a.split("=", 1)
        try: kw[k] = json.loads(v)
        except ValueError: kw[k] = v
    print(json.dumps(call(sys.argv[1], **kw), indent=1, ensure_ascii=False))
