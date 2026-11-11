// The attribute readers over every kind of value the markup parser can hand them.

import { prng } from "../lib/encode.mjs";

const VALUES = [
  undefined, null, true, false, 0, 1, -1.5, 1e21, "", " ", "true", "false", "a", "a b", "a, b", "a,b ,, c", " a | b ", "a|b|", "a||b", "a | b || c", "a || b", "|", "||", ",", "a\tb\nc", "a b", "x, y | z",
  "a\u0085b", "a\u3000b", "\ufeffa , b\u00a0", "a\u2028b|c\u0085", "\u00a0", "\u0085", " 3\u00a0", "\u00854", "-\u00a0rating", "L\u00a0: open", "a:\u3000b",
  "name rating price", "name:Venue, rating:Score", "name: Venue | rating :Score", ":x", "x:", "a:b:c", "name:", " : ", "rating:max price:min distance:min", "rating:max, price", "rating:nope", ":min", "a:min:max", "__proto__:max", "1:min 0:max b:min",
  "Open now: open | Seafood: tags~sea | ₺–₺₺: price<=2", "Open: open, Sea: tags~sea", "open || rating>4", "Good: open || rating>4.5 | Bad: (price<2", "A: b: c", ": open", "NoSpace:open", "Label: ", "L1: x |", "| L: x",
  "rating", "-rating", " - rating ", "-", "--x", "3", " 4.5 ", "-2", ".5", "5.", "1e3", "1e", "0x10", "abc", "1 2", "Infinity", "NaN",
  ["a", "b"], ["a", 1, true, null, "", " c "], [], [[1], { label: "L" }], [{ label: "A", value: "a" }, { title: "T" }, { name: "N" }, { value: "v" }, { value: 0 }, {}, { label: "" }, { label: null, title: "T2" }, { label: 5 }],
  [{ key: "name", label: "Venue" }, { field: "rating" }, { key: "x", label: null }, { key: "" }, { label: "only" }, "plain", "k:v", 7, null, { key: 3, label: 4 }],
  [{ label: "Open", where: "open" }, { filter: "price<2" }, { label: "", where: "x" }, { where: "" }, { label: "L" }, "Text: a==1", "bare", 5, null, { where: null, filter: "f" }],
  { a: 1 }, { label: "x" }, { length: 2 },
];

const DATA = { limits: { a: 1 }, trend: [1, 2], n: 5, "": "empty key", nothing: null, toString: "own" };

const PIECES = ["a", "b", "name", "rating", ":", ",", "|", " ", "-", "max", "min", "1", "open", ": ", "||", "é", "😀", "\t"];

export default function ({ call }) {
  for (const v of VALUES) call("attrs", "attrsAll", v);
  for (const v of ["limits", "trend", "n", "", "nothing", "missing", "toString", "constructor", 5, null, undefined, ["limits"], { a: 1 }]) {
    call("attrs", "dataRef", v, DATA);
    call("attrs", "dataRef", v, undefined);
    call("attrs", "dataRef", v, ["limits"]);
  }

  const rng = prng(0x61747472);
  for (let i = 0; i < 200; i++) {
    let text = "";
    for (let n = 1 + rng.int(10); n > 0; n--) text += rng.pick(PIECES);
    call("attrs-fuzz", "attrsAll", text);
  }
}
