// Turns recorded calls into the vectors that are written to disk.
//
//   {"fn","args","out"}              a call and its full result
//   {"fn","args","h"}                …or, for a large result, its hash
//   {"fn","doc","rest","from","h8"}  a sweep: the function over every prefix of a
//                                    stored document from `from` on (lengths in
//                                    UTF-16 units), 8 hex digits of hash per prefix;
//                                    "--------" marks a prefix that splits a
//                                    surrogate pair (not a string Rust can hold)
//   {"fn","base","ops","out"|"h"}    validateView over a stored base input after
//                                    the listed edits
//
// Hashes are FNV-1a 64 of the result as JSON.stringify prints it (a sweep keeps
// the low 32 bits). `node generate.mjs --explain <file> <n>` prints a full result.

import { encode, fnv1a64 } from "./encode.mjs";

// A result longer than this (as JSON) is stored as its hash. The validateView
// sweeps are thousands of near-identical problem lists; they get less room.
const inline = (family) => (family.startsWith("validate-") ? 200 : 400);
const DOC_MIN = 200;
const SKIPPED_CUT = "--------";

export class Corpus {
  // `prefix` keeps document ids from two corpora apart when they are merged.
  constructor(prefix = "d") {
    this.prefix = prefix;
    this.records = [];
    this.seen = new Set();
    this.skipped = {};
    this.docs = new Map();
  }

  skip(why) {
    this.skipped[why] = (this.skipped[why] ?? 0) + 1;
  }

  // One call. `args` are the raw arguments (not yet encoded); `out` the result in its vector form.
  add(family, fn, args, out) {
    if (typeof args[0] === "string" && !args[0].isWellFormed()) return this.skip("an argument no vector can hold");
    const key = `${family}|${fn}|${fnv1a64(JSON.stringify(args, (_k, v) => (v === undefined ? { $undef: 1 } : v)))}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    // A result that is undefined is stored as the marker the arguments use.
    const json = JSON.stringify(out === undefined ? { $undef: 1 } : out);
    this.records.push({ family, fn, args, json: json.length <= inline(family) ? json : null, h: fnv1a64(json) });
  }

  // validateView over a named base input with edits applied.
  addEdit(family, base, ops, out) {
    const json = JSON.stringify(out);
    this.records.push({ family, fn: "validateView", base, ops, json: json.length <= inline(family) ? json : null, h: fnv1a64(json) });
  }

  docId(text) {
    let id = this.docs.get(text);
    if (!id) {
      id = `${this.prefix}${this.docs.size}`;
      this.docs.set(text, id);
    }
    return id;
  }

  // family → vectors
  pack() {
    const families = new Map();
    const push = (family, v) => {
      if (!families.has(family)) families.set(family, []);
      families.get(family).push(v);
    };
    const result = (r) => (r.json != null ? { out: JSON.parse(r.json) } : { h: r.h });

    const groups = new Map();
    for (const r of this.records) {
      if (r.base !== undefined) {
        const ops = encode(r.ops);
        if (!ops) this.skip("an argument no vector can hold");
        else push(r.family, { fn: r.fn, base: r.base, ops: ops.value, ...result(r) });
        continue;
      }
      if (typeof r.args[0] === "string") {
        const key = `${r.family}|${r.fn}|${JSON.stringify(r.args.slice(1))}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
        continue;
      }
      this.full(push, r, result);
    }

    for (const group of groups.values()) {
      const byLength = [...group].sort((a, b) => b.args[0].length - a.args[0].length);
      const docs = [];
      const cuts = new Map();
      for (const r of byLength) {
        const text = r.args[0];
        let doc = docs.find((d) => d.startsWith(text));
        if (!doc && text.length >= DOC_MIN) {
          doc = text;
          docs.push(doc);
        }
        if (!doc) {
          this.full(push, r, result);
          continue;
        }
        if (!cuts.has(doc)) cuts.set(doc, new Map());
        cuts.get(doc).set(text.length, r);
      }
      for (const [doc, byCut] of cuts) {
        if (byCut.size < 3) {
          for (const r of byCut.values()) this.full(push, r, result);
          continue;
        }
        const lengths = [...byCut.keys()].sort((a, b) => a - b);
        let run = null;
        const flush = () => {
          if (run) push(run.r.family, { fn: run.r.fn, doc: this.docId(doc), rest: run.rest, from: run.from, h8: run.h8.join("") });
          run = null;
        };
        for (const at of lengths) {
          const r = byCut.get(at);
          const rest = encode(r.args.slice(1)).value;
          // A cut inside a surrogate pair was never recorded; it joins the run as a gap.
          const gap = run && at === run.next + 1 && !doc.slice(0, run.next).isWellFormed();
          if (gap) {
            run.h8.push(SKIPPED_CUT);
            run.next++;
          }
          if (!run || at !== run.next) {
            flush();
            run = { r, rest, from: at, next: at, h8: [] };
          }
          run.h8.push(r.h.slice(8));
          run.next++;
        }
        flush();
      }
    }
    return families;
  }

  full(push, r, result) {
    const args = encode(r.args);
    if (!args) this.skip("an argument no vector can hold");
    else push(r.family, { fn: r.fn, args: args.value, ...result(r) });
  }
}
