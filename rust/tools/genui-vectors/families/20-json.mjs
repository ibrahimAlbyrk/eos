// The tolerant JSON readers: edge cases, every prefix of two documents, noise.

import { prng } from "../lib/encode.mjs";

const LOOSE = [
  "", " ", "1", "-0", "0.5", "1e3", "1E-2", "01", "1.", ".5", "-", "+1", "1e", "0x10", "Infinity", "NaN", "true", "false", "null", "tru", "nul", "undefined", "True",
  '"a"', "'a'", "'it\\'s'", '"say \\"hi\\""', '"\\u00e9\\u20ba"', '"\\ud83d\\ude00"', '"\\ud83d"', '"\\ude00x"', '"\\uZZZZ"', '"\\u12"', '"\\x41"', '"\\q"', '"a\nb"', "'a\nb'", '"tab\\there"', '"unclosed', "'unclosed",
  "[]", "[1]", "[1,]", "[1,,2]", "[,1]", "[1 2]", "[1,2", "[", "]", "[[[]]]", "[1, /* c */ 2]", "[1, // c\n 2]", "[1, // never ends",
  "{}", '{"a":1}', "{a:1}", "{'a':1}", "{a:1,}", "{a:1,,}", "{,}", "{a}", "{a:}", "{a 1}", "{:1}", '{"a":1 "b":2}', "{a-b: 1, $c: 2, _d: 3, e1: 4}", "{1a: 1}", "{a:1", "{", "}", '{"a":{"b":{"c":[1,{"d":null}]}}}',
  '{"__proto__": {"x": 1}, "constructor": 2}', '{"b":1,"2":2,"a":3,"1":4,"01":5}', '{"a":1,"a":2}', "/* c */ {a: 1} // tail", "{a: 1} x", "1 2", '"a" "b"', "[1] ]",
  `${"[".repeat(64)}1${"]".repeat(64)}`, `${"[".repeat(65)}1${"]".repeat(65)}`, `${"[".repeat(66)}`, `${'{"a":'.repeat(70)}1${"}".repeat(70)}`,
  "[1,\u00a02]", "\ufeff{}", "{\u2028}", "[1\u0085]", "{a\u00a0: 1}", "'a\u2028b'", '"a\u2028b"', "1\u3000", "// c\u2028 1", "/* \u00a0 */ 2",
  "😀", '"😀"', "{😀: 1}", '{"é": "ü"}', "[1e999, -1e999]", "123456789012345678901234567890", "0.1e-400", '"\\/\\b\\f\\n\\r\\t\\\\"',
];

const PARTIAL = [
  "", "{", '{"', '{"ti', '{"title', '{"title"', '{"title":', '{"title":"', '{"title":"Kad', '{"title":"Kad"', '{"title":"Kad",', '{"title":"Kad","ui":"<Card of=\\"pl', '{"ui":"a\\', '{"ui":"a\\u', '{"ui":"a\\u00', '{"ui":"a\\u00e9',
  '{"ui":"\\ud83d', '{"ui":"\\ud83d\\ude', '{"ui":"\\ud83d\\ude00', '{"summary":"half', '{"data":{"places":[{"id":"a"},{"id":"b', '{"data":{"places":[{"id":"a"},{"id":"b"}', '{"data":{"n":12', '{"data":{"n":12,', '{"data":{"ok":tr', '{"data":{"ok":true',
  '{"data":{"ok":nul', '{"data":{"x":-', '{"data":{"x":1.', '{"data":{"x":1e', "[1,2", "[1,2,", '["a","b', "12", "12 ", "tru", "true", '"str', '"str"', '{"a":1}', '{"a":1} ', '{"a":1} x', '{"a":1}}', '{"a":01}', '{"a":1,}', "{a:1}", "{'a':1}",
  '{"a":"line\nbreak"}', '{"a":"bad \\q"}', '{"a" 1}', '{"a":1 "b":2}', "[1 2]", "nope", '{"ui":"x","ui":"y', '{"nested":{"ui":"half', '{"ui":["half', '{"ui":{"k":"half',
];

const EDGE = `{
  "title": "Kadıköy \\"akşam\\" \\u00e9 \\ud83d\\ude00 😀",
  "tone": "green",
  "data": {
    "places": [
      {"id": "moda", "rating": 4.7, "price": 2, "open": true, "note": null, "geo": [40.98, -29.02e0], "tags": ["a\\tb", "c\\/d", ""]},
      {"id": "lal", "rating": -0.5E+1, "nested": {"deep": [[1, [2, [3]]], {"k": {}}], "empty": []}}
    ],
    "2": "index key", "1": false, "n": 1234567890123456789
  },
  "actions": {"book": {"label": "Book", "kind": "send", "primary": false}},
  "ui": "<Section title=\\"A\\">\\n  <Card of=\\"places\\" pick=\\"moda\\"/>\\n  <Text>😀 \\\\ done</Text>\\n</Section>",
  "summary": "Two places."
}`;

const LOOSE_DOC = `{ // a comment
  a: 'single', "b": [1, 2, 3,], /* block */ c-d: {e: null, 'f': true,},
  g: "esc \\' \\q \\u00e9", h: -1.5e2, 😀: 1
}`;

const ALPHABET = ['"', "'", "{", "}", "[", "]", ":", ",", " ", "\n", "\\", "/", "*", "a", "u", "e", "E", "0", "1", "9", ".", "-", "+", "t", "r", "n", "l", "f", "s", "😀", "é", "$", "_"];

export default function ({ call, fixture }) {
  for (const text of LOOSE) {
    call("json", "parseLooseJson", text);
    call("json", "parsePartialJson", text);
  }
  for (const text of PARTIAL) {
    call("json", "parsePartialJson", text);
    call("json", "parsePartialJson", text, { partialKeys: ["ui", "summary", "title"] });
    call("json", "parsePartialJson", text, { partialKeys: [] });
    call("json", "parseLooseJson", text);
  }

  for (let cut = 0; cut <= EDGE.length; cut++) {
    const prefix = EDGE.slice(0, cut);
    if (!prefix.isWellFormed()) continue;
    call("json-sweep", "parsePartialJson", prefix);
    call("json-sweep", "parsePartialJson", prefix, { partialKeys: ["title", "summary"] });
    call("json-sweep", "parseLooseJson", prefix);
  }
  for (let cut = 0; cut <= LOOSE_DOC.length; cut++) {
    const prefix = LOOSE_DOC.slice(0, cut);
    if (prefix.isWellFormed()) call("json-sweep", "parseLooseJson", prefix);
  }

  const rng = prng(0x6a736f6e);
  const seeds = [EDGE, LOOSE_DOC, JSON.stringify(fixture("learn")), '{"a":[1,2,{"b":"c"}],"ui":"<T/>"}', "[true,false,null,-1.5e3,\"x\\u0041\"]"];
  for (let i = 0; i < 400; i++) {
    let text = rng.pick(seeds);
    const from = rng.int(text.length);
    text = text.slice(from, from + 20 + rng.int(160));
    for (let n = rng.int(5); n > 0; n--) {
      const at = rng.int(text.length + 1);
      text = text.slice(0, at) + rng.pick(ALPHABET) + text.slice(at + rng.int(3));
    }
    if (!text.isWellFormed()) continue;
    call("json-fuzz", "parsePartialJson", text);
    call("json-fuzz", "parseLooseJson", text);
  }
}
