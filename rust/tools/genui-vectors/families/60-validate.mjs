// validateView: every component and attribute of the catalog with good and bad
// values, every entity field, actions, the present fields, the limits, element
// structure, and seeded edits of the scenario fixtures.

import { prng } from "../lib/encode.mjs";

const MINI = {
  title: "Mini",
  summary: "A small view.",
  data: {
    places: [
      { id: "moda", type: "Place", name: "Moda", rating: 4.7, price: 2, geo: [40.98, 29.02], tags: ["sea"], hours: { until: "23:00" }, site: "moda.example", source: 1, image: "https://img.example/moda.jpg", cuisine: "Meyhane", area: "Moda" },
      { id: "lal", type: "Place", name: "Lal", rating: 4.4, price: 1, geo: [40.99, 29.03], status: "Closed", cuisine: "Kebap" },
      { id: "ocak", type: "Place", name: "Ocak", rating: 4.1, price: 3, address: "Moda Cd. 1" },
    ],
    steps: [{ title: "One", text: "First", n: 1 }, { title: "Two", text: "Second", n: 2 }],
    limits: { "ui markup": "≤ 24 KB", data: "≤ 64 KB" },
    trend: [3, 5, 4, 8],
    urls: ["https://img.example/1.jpg"],
    n: 5,
    sources: [{ title: "Guide", url: "https://guide.example/a" }, { site: "blog.example" }],
  },
  actions: {
    book: { label: "Book", kind: "send", primary: true, text: "Book {name}" },
    route: { label: "Route", kind: "open", href: "maps:{geo}" },
    pick: { label: "Pick", kind: "set", set: { chosen: 1 } },
    copyIt: { label: "Copy", kind: "copy", text: "x" },
  },
  ui: '<Card of="places" pick="moda"/>',
};

// One entity of each type (and plain rows), for the field sweep.
const ENTITIES = {
  title: "Entities",
  summary: "One of each.",
  data: {
    items: [
      { id: "p", type: "Place", name: "Place" },
      { id: "pr", type: "Product", name: "Product" },
      { id: "e", type: "Event", name: "Event" },
      { id: "pe", type: "Person", name: "Person" },
      { id: "a", type: "Article", title: "Article" },
      { id: "m", type: "Media", title: "Media" },
      { id: "f", type: "File", path: "src/a.ts" },
      { id: "g", type: "Generic", name: "Generic" },
    ],
    rows: [{ id: "r1", label: "Row" }, { label: "No id" }],
    sources: [{ title: "S1", url: "https://s.example/1" }, { title: "S2" }],
  },
  ui: '<List of="items"/>',
};

const COMMON = ['"x"', '""', "{3}", "{null}", "{true}", "{[1,2]}", '{{"a":1}}', null, '"{field}"', '"a {b} c"'];
const BY_KIND = {
  text: ['"hello"', "{1.5}", "{false}", '"title"', '"{title}"', '"name"', '"cuisine"'],
  number: ['"3"', '"0"', '"-1"', '"2.5"', '"1e3"', '"1e999"', '" 4 "', '"abc"', "{2}", "{2.5}", "{1000000000000}", '"0x10"', '".5"', '"5."', '"101"', '"601"', '"-.5"', '"1e"', "{-0}"],
  bool: ['"true"', '"false"', '"yes"', "{false}", '"TRUE"'],
  enum: [],
  numfield: ['"rating"', '"4"', "{4}", '"nope"', '" "'],
  url: ['"https://example.com/a.png"', '"HTTP://EXAMPLE.COM/x"', '"ftp://x"', '"https://a b"', '"example.com"', '"https://"', '"https://x\n"'],
  ids: ['"moda lal"', '"moda, nope"', '{["moda","lal"]}', "{7}", '"moda moda"'],
  id: ['"moda"', '"nope"', "{7}", '"{id}"', '{"moda"}', "{[\"moda\"]}", '{{"id":"moda"}}'],
  labels: ['"A | B"', '"A, B, C"', '{["A","B"]}', '{[{"label":"A","value":"a"},{"label":"B"}]}', '"Only"', "{7}", '"0, 1"', '"Open, 5"'],
  cols: ['"name rating"', '"name:Venue, rating:Score"', '"name nope"', '{[{"key":"name","label":"Venue"}]}', '"name | nope:Missing"'],
  chips: ['"Open: open | Top: rating>=4.5"', '"Cheap: price <"', '"Open: open, Sea: tags~sea"', '{[{"label":"Open","where":"open"}]}', '"open || rating>4"', '" , "', '{[{"label":"Bad","where":"(x"}]}'],
  best: ['"rating:max price:min"', '"true"', '"false"'],
  json: ['"limits"', '"trend"', '"n"', '"urls"', '"nope"', "{[1,2,3]}", '{{"A":"b"}}', '{["https://img.example/2.jpg","bad", 5]}', '"sources"', '"places"'],
  collection: ['"places"', '"steps"', '"limits"', '"trend"', '"n"', '"sources"', '"nope"', '"2bad"', '"mekân"', '"a-b"', '"a b"'],
  field: ['"name"', '"hours.until"', '"no pe"', '"nope"', '"a..b"', '"$x._y"'],
  fields: ['"rating"', '"rating price"', '"nope"', '{["rating","nope"]}'],
  actions: ['"book"', '"book route"', '"book nope"', '{["book","pick"]}', '"book, , route"'],
  action: ['"book"', '"route"', '"pick"', '"nope"', '"bad id"'],
  state: ['"party"', '"party_size"', '"party-size"', '"2x"', '"mekân"'],
  expr: ['"rating * 2"', '"sum(places.rating)"', '"state.party > 2"', '"data.nope"', '"nope + 1"', '"alert(1)"', '"1 +"', '"item.name"', '"state.chosen + data.n + places"', '" "'],
  where: ['"open"', '"rating >= 4.5"', '"rating >> 4"', '"price == state.budget"', '"(open || rating>4"', '"!status && tags ~ sea"', '"rating > 4.2"', '"price == 9"'],
  sort: ['"rating"', '"-rating"', '"- rating"', '"hours.until"', '"-nope"', '"a b"', '" rating"', '"-"'],
  tone: [],
  icon: [],
  geo: ['"true"', "{[40.98, 29.02]}", "{[95, 29]}", "{[40, 200]}", "{[-91, -181]}", "{[1]}", "{[1,2,3]}", '{["a", 2]}', "{[95, 29, 1]}", '{[1, "b", 3]}', '"here"', "{[]}"],
};
BY_KIND.int = BY_KIND.number;

const tag = (name, attrs) => `<${name}${attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}=${v}`)).join("")}/>`;

function catalogSweep({ edit, mods }) {
  const c = mods.catalog;
  const seen = new Set();
  for (const name of c.COMPONENT_NAMES) {
    const attrs = c.componentAttrs(name);
    for (const [attr, def] of Object.entries(attrs)) {
      const own = def.kind === "enum" ? [`"${def.values[0]}"`, `"${def.values[0].toUpperCase()}"`, '"nope"', "{5}"] : def.kind === "tone" ? ['"green"', '"GREEN"', '"pink"'] : def.kind === "icon" ? ['"star"', '"Star"', '"pizza"'] : BY_KIND[def.kind];
      const signature = JSON.stringify([def.kind, def.min, def.max, def.values, def.item, attr === "of" || attr === "pick" || attr === "source" ? `${name}.${attr}` : ""]);
      // The full list once per distinct definition; elsewhere one good value and one bad.
      const values = seen.has(signature) ? [own[0], "{null}"] : [...own, ...COMMON];
      seen.add(signature);
      for (const v of values) edit("validate-catalog", "mini", [["set", ["ui"], tag(name, [[attr, v]])]]);
    }
    // Attributes that are not the component's, among them names every JavaScript object inherits.
    edit("validate-catalog", "mini", [["set", ["ui"], tag(name, [["sparkle", '"x"'], ["constructor", '"x"'], ["toString", null], ["__proto__", "{1}"], ["hasOwnProperty", '"x"'], ["valueOf", '"x"'], ["x:y", '"z"']])]]);
    // A plausible complete element, with children where the component takes them.
    const required = Object.entries(c.COMPONENTS[name].attrs).filter(([, d]) => d.required).map(([attr, d]) => [attr, sample(d)]);
    const full = `<${name}${required.map(([k, v]) => ` ${k}=${v}`).join("")}>`;
    edit("validate-catalog", "mini", [["set", ["ui"], `${full}<Text>child</Text>some text</${name}>`]]);
    edit("validate-catalog", "mini", [["set", ["ui"], `${full}just text</${name}>`]]);
    edit("validate-catalog", "mini", [["set", ["ui"], `${full}</${name}>`]]);
    edit("validate-catalog", "mini", [["set", ["ui"], `<${name} of="places" pick="lal" bind="b" label="L" when="state.b">\n  <Stack><Text>x</Text></Stack>\n  <Text>y</Text>\n</${name}>`]]);
    edit("validate-catalog", "mini", [["set", ["ui"], `<${name} of="steps" title="title" text="text" meta="n" key="title" value="text" time="n" note="x" badge="title" label="text" leg="n" code="n"/>`]]);
    edit("validate-catalog", "mini", [["set", ["ui"], `<List of="places"><${name} when="rating > 4" expr="rating + nope"/></List>`]]);
  }
}

function sample(def) {
  switch (def.kind) {
    case "collection": return '"places"';
    case "id": return '"moda"';
    case "cols": return '"name rating"';
    case "chips": return '"Open: open | Cheap: price<=1"';
    case "state": return '"st"';
    case "labels": return '"A | B"';
    case "expr": return '"1 + 1"';
    case "action": return '"book"';
    case "actions": return '"book route"';
    case "url": return '"https://img.example/a.jpg"';
    case "number": case "numfield": return '"3"';
    case "enum": return `"${def.values[0]}"`;
    default: return '"x"';
  }
}

const LONG = (n) => "x".repeat(n);
const FIELD_VALUES = [null, true, false, 5, -1, 1.5, 6, 0, 1e9, "", "x", " ", LONG(41), LONG(61), LONG(101), LONG(201), LONG(301), LONG(601), LONG(1025), LONG(2049), [], [1], ["a"], [LONG(61)], [1, 2, 3], [40.98, 29.02], [95, 29], [40, 200], ["a", "b"], [1.5], [0], [99],
  {}, { a: 1 }, { from: 5 }, { until: LONG(21), closed: "no", text: LONG(81), extra: 1 }, { k: "v", n: 1, b: true }, { k: null, l: [1], m: {} },
  ["😀".repeat(30)], { ["😀".repeat(25)]: 1 }, "😀".repeat(100), "😀".repeat(101), "😀".repeat(20) + "x", "x" + "😀".repeat(20),
  "https://ok.example/x", "HTTPS://OK.EXAMPLE/X", "not a url", "example.com", "http://example.com:8080/path?q=1", "exa mple.com", "localhost", "münchen.de", "a.b", "video", "Place", "Restaurant"];
const ENTITY_FIELDS = ["id", "name", "title", "image", "images", "site", "url", "source", "tags", "rating", "reviews", "geo", "address", "status", "meta", "note", "type", "price", "hours", "area", "cuisine", "distance", "currency", "brand", "inStock", "specs",
  "start", "end", "venue", "role", "org", "author", "date", "excerpt", "kind", "duration", "path", "line", "added", "removed", "lang", "unknownField"];

const OWN_FIELDS = {
  Place: ["price", "hours", "area", "cuisine", "distance"],
  Product: ["price", "currency", "brand", "inStock", "specs"],
  Event: ["start", "end", "venue", "price"],
  Person: ["role", "org"],
  Article: ["author", "date", "excerpt"],
  Media: ["kind", "duration", "date", "author"],
  File: ["path", "line", "added", "removed", "lang"],
  Generic: [],
};

function entitySweep({ edit }) {
  const f = "validate-entities";
  const types = ENTITIES.data.items.map((it) => it.type);
  const short = [null, "x"];
  // Every value where a field is checked: shared fields on the first type, a
  // type's own fields on that type, the fields a plain row is checked for on a
  // row. Elsewhere the field is free-form and two values show it.
  for (const field of ENTITY_FIELDS) {
    types.forEach((type, i) => {
      const checked = OWN_FIELDS[type].includes(field) || (i === 0 && !Object.values(OWN_FIELDS).flat().includes(field));
      for (const v of checked ? FIELD_VALUES : short) edit(f, "entities", [["set", ["data", "items", i, field], v]]);
      edit(f, "entities", [["del", ["data", "items", i, field]]]);
    });
    for (const v of ["id", "rating", "geo", "image", "source", "type"].includes(field) ? FIELD_VALUES : short) edit(f, "entities", [["set", ["data", "rows", 0, field], v]]);
  }
  for (const field of ["title", "name", "url", "site", "at", "note", "extra"]) {
    for (const v of FIELD_VALUES) edit(f, "entities", [["set", ["data", "sources", 1, field], v]]);
  }
  for (const v of [null, 5, "x", [], {}, { title: "" }, { name: "N" }, { url: "https://u.example" }, { site: "s.example" }, { note: "only a note" }, { title: 5, name: "N" }, { title: LONG(201) }]) {
    edit(f, "entities", [["set", ["data", "sources", 0], v]]);
  }
  for (const v of [null, 5, "x", {}, [], [null], [{ title: "a" }, 5, "x"], [{ title: "a", id: 1 }, { title: "b", id: { x: 1 } }, { title: "c", id: [1, [2, null]] }]]) edit(f, "entities", [["set", ["data", "sources"], v]]);
  // Source references against the two sources there are (and none).
  for (const v of [0, 1, 2, 3, 2.5, -1, [1, 2], [1, 3, 9], [0, "a", 3], Array.from({ length: 11 }, () => 1), "1", null]) {
    edit(f, "entities", [["set", ["data", "items", 0, "source"], v]]);
    edit(f, "entities", [["set", ["data", "rows", 0, "source"], v]]);
    edit(f, "entities", [["set", ["data", "items", 0, "source"], v], ["del", ["data", "sources"]]]);
  }
  // Ids: repeats, numbers that print alike, lists of ids for pick.
  for (const ids of [["a", "a"], [1, "1"], [1, 1.0], ["a", "A"], [null, null], [{}, {}], [1e21, "1e+21"], [0.1, "0.1"], ["", ""], [true, "true"]]) {
    edit(f, "entities", [["set", ["data", "rows", 0, "id"], ids[0]], ["set", ["data", "rows", 1, "id"], ids[1]], ["set", ["ui"], `<Table of="rows" cols="label"/><Card of="rows" pick=${typeof ids[1] === "string" ? JSON.stringify(ids[1]) : `{${JSON.stringify(ids[1])}}`}/>`]]);
  }
  // Collections: what counts as one, names, reserved names, mixed lists.
  for (const [key, v] of [["list", [1, 2]], ["list", []], ["list", [{ a: 1 }, 2]], ["list", [null, { a: 1 }]], ["list", ["x", { a: 1 }, [1]]], ["list", [[]]], ["item", [{ a: 1 }]], ["state", 1], ["data", {}], ["true", 1], ["false", []], ["null", "x"],
    ["2bad", [{ a: 1 }]], ["has space", 1], ["-x", 1], ["_ok", [{ a: 1 }]], ["a-b", [{ a: 1 }]], ["mekân", [{ a: 1 }]], [LONG(40), 1], [LONG(41), 1], ["😀", 1], ["𝒜".repeat(40), [{ a: 1 }]], ["𝒜".repeat(41), [{ a: 1 }]], ["x𝒜٣_-", [{ a: 1 }]], ["a.b", 1], ['q"uote', 1], ["__proto__", [{ a: 1 }]], ["constructor", [{ a: 1 }]], ["1", [{ a: 1 }]], ["0", "zero"],
    ["typed", [{ type: "Place", id: 1 }, { type: "Palce", id: 2 }, { type: 3, id: 3 }, { id: 4 }]], ["untyped", [{ type: "feat", n: 1 }, { type: "fix", n: 2 }]], ["nofile", [{ type: "File", id: "f" }, { type: "File", id: "g", path: "" }]],
    ["images", Array.from({ length: 13 }, (_, i) => ({ id: i, type: "Generic", name: "n", images: Array.from({ length: 13 }, (_, k) => `https://img.example/${i}-${k}.jpg`) }))],
    ["pics", Array.from({ length: 41 }, (_, i) => ({ id: i, image: `https://img.example/${i}.jpg` }))], ["pics", Array.from({ length: 41 }, () => ({ image: "https://img.example/same.jpg" }))],
    ["sites", [{ site: "A.example" }, { site: "a.EXAMPLE" }, { site: "b.example" }, { site: 5 }]],
    ["sites", [{ site: "ΟΔΟΣ.gr" }, { site: "οδοσ.gr" }, { site: "οδος.gr" }, { site: "ΟΔΟΣ" }, { site: "οδος" }, { site: "ΟΔΟΣ gr" }, { site: "οδος gr" }, { site: "İ.example" }, { site: "i̇.example" }, { site: "i.example" }, { site: "STRASSE.de" }, { site: "straße.de" }]],
    ["typedSites", [{ id: 1, type: "Generic", name: "a", site: "ΟΔΟΣ.gr" }, { id: 2, type: "Generic", name: "b", site: "οδοσ.gr" }, { id: 3, type: "Generic", name: "c", site: "İ.EXAMPLE" }, { id: 4, type: "Generic", name: "d", site: "x.ΕΛ" }, { id: 5, type: "Generic", name: "e", site: "HTTPS://Ω.example:80/Path" }]]]) {
    edit(f, "entities", [["set", ["data", key], v]]);
    edit(f, "entities", [["set", ["data", key], v], ["set", ["ui"], `<List of=${JSON.stringify(key)}/><Value expr=${JSON.stringify(/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(key) ? key : "1")}/>`]]);
  }
  for (const v of [null, 5, "x", [], [{ id: 1 }], {}, { places: "x" }]) edit(f, "entities", [["set", ["data"], v]]);
  edit(f, "entities", [["del", ["data"]]]);
}

function actionSweep({ edit }) {
  const f = "validate-actions";
  for (const field of ["label", "kind", "primary", "text", "href", "set", "icon", "extra", "constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
    for (const v of [null, true, false, 5, "", "x", "send", "open", "star", "pizza", LONG(61), LONG(2049), LONG(4001), [], ["a"], {}, { a: 1 }, { "__proto__": 1 }, { "__proto__": 1, b: 2 }, "{state.chosen} {state.nope} { state.b }", "https://x.example", "javascript:alert(1)", "  /abs/path", "~/home", "{geo}", "tel:1", "MAPS:x", "relative/path"]) {
      for (const id of ["book", "route", "pick", "copyIt"]) edit(f, "mini", [["set", ["actions", id, field], v]]);
    }
    for (const id of ["book", "route", "pick", "copyIt"]) edit(f, "mini", [["del", ["actions", id, field]]]);
  }
  for (const kind of ["send", "prefill", "open", "copy", "set", "nope", 5]) {
    for (const rest of [{}, { text: "t" }, { text: "" }, { href: "https://x.example" }, { href: "" }, { href: " " }, { set: {} }, { set: { a: 1, b: 2 } }, { set: [] }, { text: "{state.a}{state.b}", href: "/p/{state.c}", set: { a: 1 } }]) {
      edit(f, "mini", [["set", ["actions", "extra"], { label: "Extra", kind, ...rest }]]);
    }
  }
  for (const [id, v] of [["bad id", { label: "x", kind: "send" }], ["2x", { label: "x", kind: "send" }], ["a-b", { label: "x", kind: "send" }], ["mekân", { label: "x", kind: "send" }], ["x", null], ["x", 5], ["x", "send"], ["x", []], ["x", {}], ["__proto__", { label: "x", kind: "send" }],
    ["constructor", { label: "x", kind: "send" }], ["1", { label: "one", kind: "send" }], ["p2", { label: "P2", kind: "send", primary: true }]]) {
    edit(f, "mini", [["set", ["actions", id], v]]);
    edit(f, "mini", [["set", ["actions", id], v], ["set", ["ui"], `<Actions ids=${JSON.stringify(id)}/><Form action=${JSON.stringify(id)}><Field bind="note"/></Form>`]]);
  }
  edit(f, "mini", [["set", ["actions", "p2"], { label: "P2", kind: "send", primary: true }], ["set", ["actions", "p3"], { label: "P3", kind: "send", primary: true }], ["set", ["actions", "p4"], { label: "P4", kind: "copy", text: "x", primary: true }]]);
  for (const v of [null, 5, "x", [], [{ label: "x", kind: "send" }], {}]) {
    edit(f, "mini", [["set", ["actions"], v]]);
    edit(f, "mini", [["set", ["actions"], v], ["set", ["ui"], '<Card of="places" pick="moda" actions="book"/><Callout action="book">x</Callout>']]);
  }
  edit(f, "mini", [["del", ["actions"]], ["set", ["ui"], '<Card of="places" pick="moda" actions="book"/>']]);
}

function fieldSweep({ edit }) {
  const f = "validate-fields";
  const values = [null, true, 5, "", " ", "x", [], {}, "\u0085", "\u00a0", "\ufeff", "\u200b", "\u2028 \u3000\t\n", "\u00a0x\u00a0", "blue", "BLUE", "star", "v_7Hq2abcdEFGH", "v_7Hq2abcdEFG!", "v_short", LONG(80), LONG(81), LONG(600), LONG(601), "😀".repeat(40), "😀".repeat(41), "😀".repeat(300), "😀".repeat(301)];
  for (const key of ["title", "tone", "icon", "replaces", "ui", "summary", "extra", "html", "constructor"]) {
    for (const v of values) edit(f, "mini", [["set", [key], v]]);
    edit(f, "mini", [["del", [key]]]);
  }
  for (const v of [null, true, 5, "present", [], [MINI]]) edit(f, "mini", [["set", [], v]]);
  edit(f, "mini", [["set", [], {}]]);
  edit(f, "mini", [["set", [], { ui: 5 }]]);
  edit(f, "mini", [["set", [], { title: {}, ui: "<<<>>>", summary: [] }]]);
  edit(f, "mini", [["set", [], { summary: "s", ui: "<Text>x</Text>", title: "t", zeta: 1, alpha: 2, "1": 3 }]]);
}

function limits({ edit }) {
  const f = "validate-limits";
  const kb = 1024;
  for (const n of [24 * kb - 14, 24 * kb - 13, 24 * kb - 12, 24 * kb + 37, 25 * kb, 30 * kb + 512]) edit(f, "mini", [["set", ["ui"], `<Text>${"a".repeat(n)}</Text>`]]);
  edit(f, "mini", [["set", ["ui"], `<Text>${"é".repeat(12 * kb)}</Text>`]]);
  edit(f, "mini", [["set", ["ui"], `<Text>${"😀".repeat(6 * kb)}</Text>`]]);
  for (const n of [62 * kb, 64 * kb - 700, 64 * kb - 600, 64 * kb - 500, 64 * kb, 65 * kb, 100 * kb + 51]) edit(f, "mini", [["set", ["data", "blob"], "y".repeat(n)]]);
  edit(f, "mini", [["set", ["data", "blob"], "ü".repeat(32 * kb)]]);
  for (const n of [1, 2, 3, 8, 9, 12]) {
    const items = Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `Item ${i}`, rating: 3 + (i % 3), price: 1 + (i % 4), tags: i % 2 ? ["odd"] : [] }));
    for (const attrs of ["", ' limit="Infinity"', ' limit="1e1"', ' limit=""', ' limit="+2"', ' limit="0b11"', ' limit="0o7"', ' limit="0X2"', ' limit=".5e1"', ' limit="2."', " limit={null}", " limit={false}", ' limit={{"a":1}}', " limit={[]}", " limit={[1,2]}",
      ' limit="  "', ' limit="1_0"', ' limit="-0"', ' limit="1e400"', ' limit="２"', ' limit="8"', ' limit="2"', ' limit="2.5"', ' limit="0"', ' limit="-3"', ' limit="abc"', ' limit="0x8"', " limit={8}", " limit={[4]}", ' limit=" 3 "', " limit", ' where="rating >= 4"', ' where="tags ~ odd"', ' where="price == state.p"', ' where="rating >"',
      ' skip="i0 i1"', ' skip="i0, nope"', " skip={[\"i0\",\"i2\"]}", ' skip="i0" limit="8" where="!tags"', ' where="rating >= 4 || (price==1 && !tags)"']) {
      edit(f, "mini", [["set", ["data", "items"], items], ["set", ["ui"], `<Carousel of="items"${attrs}/>`]]);
    }
    edit(f, "mini", [["set", ["ui"], `<Carousel>${"<Text>c</Text>".repeat(n)}</Carousel>`]]);
    edit(f, "mini", [["set", ["ui"], `<Tabs labels="A | B">${'<Stack label="L"/>'.repeat(n)}<Stack/></Tabs>`]]);
    edit(f, "mini", [["set", ["ui"], `<Tabs>${"<Stack/>".repeat(n)}</Tabs>`]]);
    edit(f, "mini", [["set", ["ui"], '<Map of="places"/>'.repeat(n)]]);
    edit(f, "mini", [["set", ["ui"], Array.from({ length: n * 6 }, (_, i) => `<Image src="https://img.example/u${i}.jpg"/>`).join("\n")]]);
    edit(f, "mini", [["set", ["ui"], `<Segmented bind="s" options="${Array.from({ length: n }, (_, i) => `O${i}`).join(" | ")}" default="O1"/>`]]);
  }
  for (const depth of [7, 8, 9, 10, 12, 30, 1000, 3000]) {
    edit(f, "mini", [["set", ["ui"], `${"<Stack>".repeat(depth)}<Text>deep</Text>${"</Stack>".repeat(depth)}`]]);
    edit(f, "mini", [["set", ["ui"], `${"<Stack>\n".repeat(depth)}<Text>deep</Text>`]]);
    edit(f, "mini", [["set", ["ui"], `${"<div>".repeat(depth)}<Text>deep</Text>${"</div>".repeat(depth)}`]]);
  }
  edit(f, "mini", [["set", ["data", "urls"], Array.from({ length: 41 }, (_, i) => `https://img.example/g${i}.jpg`)], ["set", ["ui"], '<Gallery images="urls"/>']]);
  edit(f, "mini", [["set", ["data", "urls"], Array.from({ length: 39 }, (_, i) => `https://img.example/g${i}.jpg`)], ["set", ["ui"], '<Gallery images="urls"/><Image src="https://img.example/moda.jpg"/><Image src="{image}"/>']]);
}

const STRUCTURE = [
  "", " ", "just text", "<!-- only a comment -->", "<Text>hi <b>there</b></Text>", "<div><Text>x</Text></div>", "<text>x</text>", "<Card2/>", "<Stack><Unknown><Text>x</Text><Map of=\"places\"/></Unknown></Stack>",
  '<Section title="a">\n  <Text>x</Text>\n', "<Stack><Text>a</Stack>", "</Stack>", '<Card of="places" pick="moda" pick="lal"/>', '<Card of="places" pick="unclosed/>', "<Card of={{{", '<Card of={not json} pick="moda"/>',
  '<Sources/>', '<Sources of="sources"/>', '<Sources of="places"/>', '<Sources of="nope"/>', '<Sources of="limits"/>', "<Sources of={5}/>", '<List of="sources"/>', '<Table of="sources" cols="title url"/>',
  '<Text of="places">x</Text>', '<Text of="nope">x</Text>', '<Text of="limits">x</Text>', '<Stack of="trend"/>', '<Card of="limits" pick="x"/>', '<Card of="trend" pick="x"/>', '<Card of="n" pick="x"/>', '<KeyValue of="limits"/>', '<KeyValue items="limits"/>',
  '<Card of="places" pick="kiyi"/>', '<Card of="places" pick={7}/>', '<Card of="places" pick/>', '<Card of="places" pick={null}/>', '<Card of="places" pick={["moda"]}/>', '<Card of="places" pick="{state.sel}"/>', '<Card of="steps" pick="One"/>', '<Hero of="steps" pick="x">why</Hero>',
  '<List of="places" skip="moda nope" sort="-rating" where="open"/>', '<List of="places" sort="nope.x"/>', '<List of="places" sort="-  hours.until"/>', '<List of="places" sort="-"/>', '<List of="places" sort=" rating"/>', '<List of="places" skip={["moda", 5, "x"]}/>',
  '<Table of="places" cols="name stars rating:Score"/>', '<Table of="places" cols={[{"key":"name"},{"field":"nope"},"geo"]}/>', '<Table of="places" cols=""/>', '<Table of="places" cols={5}/>', '<Table of="places"/>',
  '<Chart type="bar"/>', '<Chart type="bar" of="places" x="name" y="rating price nope"/>', '<Chart type="line" values="trend"/>', '<Chart type="line" values="n"/>', '<Chart type="line" values="nope"/>', '<Chart type="pie" of="places" x="nope"/>',
  '<Meter of="places" value="rating"/>', '<Meter of="places" value="nope"/>', '<Meter of="places" value="4.5"/>', '<Meter of="places" value="{rating}"/>', "<Meter of=\"places\" value={4}/>", '<Meter value="rating"/>', '<Meter value=""/>', '<Meter of="places" value="rating" label="name"/>',
  '<Map of="places"/>', '<Map of="steps"/>', '<Map of="places"/>\n<Map of="places" route/>\n<Map of="places"/>', '<Map of="places" you={[40.98, 29.02]} zoom="20" height="100"/>',
  '<Filters of="places" chips="Open: open | Cheap: price<=1" on="Open, 1, 2, Nope"/>', '<Filters of="places" chips="Cheap: price <"/>', '<Filters of="nope" chips="Open: open"/>', '<Filters of="places" chips=""/>', '<Filters of="places" chips={[]}/>', '<Filters of="places" chips={true}/>',
  '<Filters of="places"/>', '<Filters chips="A: open"/>', '<Filters of="places" chips="A: open" on="0"/>', '<Filters of="places" chips="A: open" on={[0, "A", "B"]}/>', '<Filters of="places" chips="A: open" on="00"/>', '<Filters of="places" chips="A: open" on="1e0"/>',
  '<Stat label="Commits" value="12" source={1}/>', '<Stat label="Commits" value="12" source={9}/>', '<Quote source="5">Best.</Quote>', '<Rating value="4.7" source="{source}"/>', '<Rating value="4.7" source="abc"/>', '<Rating value="4.7" source="0"/>', '<Rating value="4.7" source="2.5"/>',
  '<Rating value="4.7" source="101"/>', '<Rating value="4.7" source="3"/>', "<Rating value=\"4.7\" source={[3]}/>", '<Rating value="7"/>', "<Rating/>", '<Stat label="a" value="b" spark="trend"/>', '<Stat label="a" value="b" spark="nope"/>', '<Stat label="a" value="b" spark="n"/>',
  '<Gallery/>', '<Gallery images="urls"/>', '<Gallery images="trend"/>', '<Gallery images="limits"/>', '<Gallery images={["https://img.example/a.jpg", "nope", 3]}/>', '<Gallery of="places" field="image"/>', '<Gallery of="places" images="urls"/>',
  '<Image src="https://img.example/a.jpg"/><Image src="https://img.example/a.jpg"/>', '<Image src="{image}"/>', '<Image src="nope"/>', "<Image/>", '<Logo/>', '<Logo site="x.example"/>', '<Price/>', '<Price level="2"/>', '<Progress/>', '<Progress expr="done / total"/>',
  '<Tabs><Stack label="A"/><Stack label="B"/></Tabs>', '<Tabs labels="A | B | C"><Stack/><Stack/></Tabs>', "<Tabs><Stack/></Tabs>", "<Tabs/>", "<Tabs>text only</Tabs>", '<Tabs labels={["A"]}><Stack/><Stack label={5}/><Stack label="C"/></Tabs>',
  '<Segmented bind="day" options="Cumartesi | Pazar" default="Cuma"/>', '<Segmented bind="day" options="Only"/>', '<Segmented bind="day" options=""/>', '<Segmented bind="day"/>', '<Select bind="d" options={[{"label":"Sat","value":"sat"},{"label":"Sun"}]} default="sat"/>',
  '<Select bind="d" options={[{"label":"Sat","value":"sat"},{"label":"Sun"}]} default="Sat"/>', '<Select bind="d" options={[{"label":"Sat","value":"sat"},{"label":"Sun"}]} default="mon"/>', '<Choice bind="q" options="A | B" default="{x}">Question?</Choice>', '<Choice bind="q" options={5}/>',
  '<Stepper bind="party" min="1" max="12" default="2"/>\n<Value expr="party * 2"/>', '<Value expr="party * 2"/>', '<Value expr="state.party + data.n + data.nope + item.x + chosen + places + trend"/>', '<List of="places"><Value expr="rating * unknown"/></List>',
  '<List of="places"><Stack><Value expr="rating * unknown"/></Stack></List><Value expr="rating"/>', '<Value expr="sum(places.rating"/>', '<Value expr="a"/><Value expr="a"/>', '<Text when="state.x">a</Text><Toggle bind="x"/>', '<Text when="1 +">a</Text>',
  '<Form action="route"><Field bind="note"/></Form>', '<Form action="book"><Field bind="note"/></Form>', '<Form action="nope"/>', "<Form/>", '<Callout action="nope">x</Callout>', '<Hero of="places" pick="moda" actions="book call">Why.</Hero>', '<Actions ids="book route nope"/>',
  '<Steps of="steps" title="title" text="text"/>', '<Steps of="steps" title="{title}" text="{text}"/>', "<Steps/>", "<Steps><Text>a</Text></Steps>", '<KeyValue of="steps" key="title" value="n"/>', '<List of="places" meta="cuisine" title="Name" badge="rating"/>', '<Timeline of="steps" time="n" title="title"/>',
  '<Divider label="or"/>', "<Divider>text</Divider>", "<Divider><Text>x</Text></Divider>", "<Text><Badge>x</Badge> and <Text>y</Text></Text>", '<Code lang="js">let a = <b>;</Code>', "<Code><Text>x</Text></Code>", '<Badge tone="GREEN" icon="STAR">x</Badge>',
  '<Card of="places" pick="moda" sparkle/>\n<Table of="places" cols="name stars"/>\n<Value expr="party * 2"/>', '<Section title="' + "t".repeat(30) + '"><Text>x</Text></Section>', '<Section title="' + "😀".repeat(14) + '" bad="1"/>', '<Disclosure><Text>x</Text></Disclosure>',
];

function structure({ edit }) {
  for (const ui of STRUCTURE) {
    edit("validate-structure", "mini", [["set", ["ui"], ui]]);
    edit("validate-structure", "mini", [["set", ["ui"], ui], ["del", ["data"]]]);
  }
  for (const ui of STRUCTURE.slice(8, 60)) edit("validate-structure", "mini", [["set", ["ui"], ui], ["del", ["data", "sources"]], ["del", ["actions"]]]);
}

const JUNK = [null, true, false, 0, 1, -1, 2.5, 6, 100, "", "x", "moda", "places", "book", "Place", "File", "https://img.example/z.jpg", "not a url", [], [1], ["a", "b"], [40, 29], [95, 500], {}, { id: "z" }, { a: { b: [1] } }, LONG(70), LONG(700)];
const UI_BITS = ["<", ">", "/>", "</", '"', "'", "{", "}", " ", "\n", "=", "<Stack>", "</Stack>", "<Text>x</Text>", '<Card of="places" pick="moda"/>', ' of="places"', ' pick="nope"', ' when="x > 1"', ' bind="k"', ' actions="book nope"', " flag", " n={3}", ' title="{name}"', '<Map of="places"/>',
  "<Value expr=\"a +\"/>", '<Filters of="places" chips="A: open | B: x >"/>', "<Tabs>", "</Tabs>", "😀", "&amp;", "<!--", "-->", "<Code>", "</Code>"];

function paths(v, at, out) {
  out.push(at);
  if (Array.isArray(v)) v.forEach((x, i) => paths(x, [...at, i], out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) paths(x, [...at, k], out);
  return out;
}

function fuzz({ edit, fixture, base }) {
  const rng = prng(0x76616c69);
  const names = ["restaurants", "trip", "tests", "learn", "mini"];
  const inputs = { mini: MINI };
  for (const name of names.slice(0, 4)) {
    inputs[name] = fixture(name);
    base(name, inputs[name]);
  }
  for (const name of names) edit("validate-fuzz", name, []);
  for (let i = 0; i < 600; i++) {
    const name = rng.pick(names);
    const input = inputs[name];
    const ops = [];
    for (let n = 1 + rng.int(3); n > 0; n--) {
      if (rng.chance(0.4)) {
        // Splice the markup; both ends must fall between characters, not inside a surrogate pair.
        const ui = input.ui;
        const start = rng.int(ui.length + 1);
        let count = rng.chance(0.5) ? 0 : rng.int(40);
        if (start + count > ui.length) count = ui.length - start;
        if (!ui.slice(0, start).isWellFormed() || !ui.slice(start + count).isWellFormed() || ops.some((op) => op[0] === "splice")) continue;
        ops.push(["splice", ["ui"], start, count, rng.chance(0.7) ? rng.pick(UI_BITS) + (rng.chance(0.3) ? rng.pick(UI_BITS) : "") : ""]);
      } else {
        const all = [...paths(input.data ?? {}, ["data"], []), ...paths(input.actions ?? {}, ["actions"], [])].filter((p) => p.length > 1);
        const at = rng.pick(all);
        if (ops.some((op) => op[0] !== "splice" && (op[1].join("/").startsWith(at.join("/")) || at.join("/").startsWith(op[1].join("/"))))) continue;
        const kind = rng.int(10);
        if (kind < 6) ops.push(["set", at, rng.pick(JUNK)]);
        else if (kind < 8) ops.push(["del", at]);
        else ops.push(["set", [...at.slice(0, -1), rng.pick(["id", "type", "rating", "geo", "image", "source", "kind", "label", "href", "text", "set", "primary", "price", "hours", "site", "tags", "extra"])], rng.pick(JUNK)]);
      }
    }
    // An edit may address something an earlier one removed; such a case is dropped, not recorded.
    try {
      edit("validate-fuzz", name, ops);
    } catch {
      continue;
    }
  }
}

export default function (api) {
  api.base("mini", MINI);
  api.base("entities", ENTITIES);
  catalogSweep(api);
  entitySweep(api);
  actionSweep(api);
  fieldSweep(api);
  limits(api);
  structure(api);
  fuzz(api);
}
