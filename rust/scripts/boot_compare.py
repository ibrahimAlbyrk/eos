#!/usr/bin/env python3
"""Compares what two boots left in two copies of one data folder.

    boot_compare.py <before> <node copy> <node window> <rust copy> <rust window>

<before> is a third, untouched copy (all three made by private-copy.sh, with
paths of the same length: each copy's own path compares as "<home>"); a window is "start_ms:end_ms", the span of
that side's boot. Prints, per table of state.db, the row counts before and on
each side, rows one side removed that the other kept, rows one side added, and
the columns whose values differ between the sides; then the files each side
added, removed or changed. A time inside a side's own window is that boot's
"now" and compares equal to the other side's "now". Prints names, ids and
counts, never the values themselves. Exits 1 when the sides differ.
"""

import json
import os
import sqlite3
import sys

SKIP_FILES = {"ui-token", "daemon.sock", "daemon.pid", "wire-daemon.pid", "REAL_DATA", "raw.sock"}
SKIP_DIRS = {"logs", "backups", "engine", ".staging"}


def window(text):
    start, end = text.split(":")
    return int(start), int(end)


def boot_time(value, win):
    """A time this boot wrote: ms, or s, or an ISO string, inside its window."""
    start, end = win
    if isinstance(value, (int, float)):
        return start <= value <= end or start // 1000 <= value <= end // 1000 + 1
    if isinstance(value, str) and len(value) >= 20 and value[4:5] == "-" and value[10:11] == "T":
        from datetime import datetime

        try:
            ms = int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return False
        return start - 1000 <= ms <= end + 1000
    return False


def normalized(value, win, home):
    if boot_time(value, win):
        return "<boot>"
    if isinstance(value, str):
        value = value.replace(home, "<home>")
    if isinstance(value, str) and value[:1] in "{[":
        try:
            parsed = json.loads(value)
        except ValueError:
            return value
        return json.dumps(deep(parsed, win), sort_keys=True)
    return value


def deep(value, win):
    if isinstance(value, dict):
        return {k: deep(v, win) for k, v in value.items()}
    if isinstance(value, list):
        return [deep(v, win) for v in value]
    return "<boot>" if boot_time(value, win) else value


def tables(db):
    return [r[0] for r in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]


def keyed(db, table):
    cols = [r[1] for r in db.execute(f'pragma table_info("{table}")')]
    pk = [r[1] for r in sorted(db.execute(f'pragma table_info("{table}")'), key=lambda r: r[5]) if r[5] > 0]
    select = ", ".join(f'"{c}"' for c in cols)
    rows = {}
    for row in db.execute(f'select rowid, {select} from "{table}"'):
        values = dict(zip(cols, row[1:]))
        key = tuple(values[c] for c in pk) if pk else (row[0],)
        rows[key] = values
    return cols, rows


def open_ro(home):
    return sqlite3.connect(f"file:{os.path.join(home, 'state.db')}?mode=ro", uri=True)


def files(home):
    out = {}
    for root, dirs, names in os.walk(home):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            if name in SKIP_FILES or name.startswith("state.db"):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, home)
            with open(path, "rb") as f:
                out[rel] = f.read().replace(home.encode(), b"<home>")
    return out


def main():
    before, node, node_win, rust, rust_win = sys.argv[1:6]
    wins = {"node": window(node_win), "rust": window(rust_win)}
    dbs = {"before": open_ro(before), "node": open_ro(node), "rust": open_ro(rust)}
    differ = False
    print(f"{'table':<28} {'before':>8} {'node':>8} {'rust':>8}  differences")
    for table in tables(dbs["before"]):
        cols, b = keyed(dbs["before"], table)
        _, n = keyed(dbs["node"], table)
        _, r = keyed(dbs["rust"], table)
        notes = []
        node_removed, rust_removed = set(b) - set(n), set(b) - set(r)
        if node_removed != rust_removed:
            only_node = len(node_removed - rust_removed)
            only_rust = len(rust_removed - node_removed)
            if only_rust:
                notes.append(f"rust removed {only_rust} rows node kept")
            if only_node:
                notes.append(f"node removed {only_node} rows rust kept")
        node_added, rust_added = set(n) - set(b), set(r) - set(b)
        if len(node_added) != len(rust_added):
            notes.append(f"added: node {len(node_added)}, rust {len(rust_added)}")
        changed = {}
        for key in set(n) & set(r):
            for col in cols:
                nv = normalized(n[key][col], wins["node"], node)
                rv = normalized(r[key][col], wins["rust"], rust)
                if nv != rv:
                    changed[col] = changed.get(col, 0) + 1
        if changed:
            notes.append("values differ: " + ", ".join(f"{c} ×{k}" for c, k in sorted(changed.items())))
        differ |= bool(notes)
        print(f"{table:<28} {len(b):>8} {len(n):>8} {len(r):>8}  {'; '.join(notes) or 'same'}")
    fb, fn, fr = files(before), files(node), files(rust)
    for name, side in (("node", fn), ("rust", fr)):
        added = sorted(set(side) - set(fb))
        removed = sorted(set(fb) - set(side))
        changed = sorted(k for k in set(fb) & set(side) if fb[k] != side[k])
        print(f"files {name}: added {added or '-'}; removed {removed or '-'}; changed {changed or '-'}")
    same_files = {k for k in set(fn) | set(fr) if fn.get(k) == fr.get(k)}
    if same_files != set(fn) | set(fr):
        differ = True
        print("files that differ between the sides:", sorted((set(fn) | set(fr)) - same_files))
    sys.exit(1 if differ else 0)


if __name__ == "__main__":
    main()
