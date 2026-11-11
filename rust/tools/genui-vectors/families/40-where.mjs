// Filters: parsing, and matching every filter against a set of items.

import { prng } from "../lib/encode.mjs";

const ITEMS = [
  { id: "moda", name: "Moda Kıyı", rating: 4.7, price: 2, tags: ["Sea", "meyhane"], hours: { until: "00:00" }, area: "Moda", open: true },
  { id: "rihtim", name: "Rıhtım", rating: 4.4, price: 1, tags: [], hours: { until: "21:00" }, status: "closing" },
  { id: "sofra", name: "Sofra", rating: 4.3, price: 2, tags: ["rez"], hours: { closed: true } },
  { id: "yel", name: "Yel", rating: "4.6", price: 3, tags: ["meyhane", "rez"], status: "Closed", flag: false },
  { id: 5, name: "O'Brien (Moda)", rating: null, price: "2", tags: "sea view", status: "CLOSED", nested: { a: { b: 0 } }, list: [1, "2", true, null] },
  { id: "greek", name: "ΟΔΟΣ Σ", status: "ΚΛΕΙΣΤΌΣ", tags: ["İstanbul", "STRASSE", "Straße"], area: "IĞDIR" },
  {},
];
const STATE = { budget: 2, mode: "off", all: false, q: "MEY", min: "4.5", tags: ["rez"], none: null, deep: { k: 1 } };

const FILTERS = [
  "open", "!open", "! open", "open ", "Open", "opened", "!opened", "name", "!name", "status", "!status", "tags", "!tags", "flag", "nested.a.b", "!nested.a.b", "nested.a", "hours.closed", "!hours.closed", "missing.deep",
  "rating >= 4.5", "rating>=4.5", "rating > 4.6", "rating < 4.4", "rating <= 4.4", "rating == 4.7", "rating = 4.7", "rating === 4.7", "rating != 4.7", "rating !== 4.7", "rating == '4.6'", "rating == 4.60", "rating == null", "rating != null",
  "price == 2", "price == '2'", "price > 1", "price >= state.budget", "price == state.budget", "price == {state.budget}", "price == { state.budget }", "price == {state.budget", "price == state.budget}", "price < state.missing", "price == state.none",
  "state.all", "!state.all", "state.mode == off", "state.mode != 'off'", "state.mode ~ OF", "state.deep.k == 1", "state.budget > 1", "state.all || rating > 4.5", "name ~ state.q", "tags ~ state.q", "rating >= state.min", "tags == state.tags",
  "name == Sofra", "name == sofra", "name == 'Sofra'", 'name == "Sofra"', "name == 'sofra'", "name ~ moda", "name ~ 'Moda K'", "name ~ ''", "name == Moda Kıyı", "name == O'Brien (Moda)", "name == 'O'Brien (Moda)'", "name ~ O'Brien", "name ~ (Moda)",
  "tags ~ sea", "tags ~ SEA", "tags == rez", "tags != rez", "tags == Sea", "tags ~ view", "tags == 'sea view'", "list == 1", "list == 2", "list == true", "list == null", "list ~ tr", "status == closed", "status ~ clos", "status != Closed",
  "hours.until > 20:00", "hours.until >= 21:00", "hours.until < 12:00", "hours.until == 00:00", "hours > 1", "hours == 1", "hours ~ x", "nested ~ a", "id == 5", "id == '5'", "id > 4", "id ~ 5", "id == moda", "flag == false", "flag == true", "flag != false", "open == true",
  "open == 'true'", "open == 1", "open > 0", "flag < 1", "rating > abc", "name > M", "name < n", "name >= 'Sofra'", "area == Moda && price == 2", "open && rating > 4.5", "open || rating > 4.5", "!open || price == 1", "price == 1 || price == 3 && rating > 4.5",
  "(price == 1 || price == 3) && rating > 4.5", "!(price == 2)", "!(open)", "!(!open)", "!( open && price == 2 )", "! (price == 2 || price == 3)", "!(!(price == 2))", "((open))", "(open", "open)", "(open))", "()", "( )", "(open) (price==2)", "open price==2",
  "open && ", "&& open", "open &&& price==2", "open & price==2", "open | price==2", "open || || price==2", "price ==", "price == ", "== 2", "price", "price == == 2", "price =< 2", "price >> 2", "price <> 2", "price ~~ 2", "price ! 2", "price !=", "price is 2",
  "1 == 1", "'name' == Sofra", "name.first.second == x", "name. == x", ".name == x", "na me == x", "name == a && b", "name == 'a && b'", "name == \"a || b\" || open", "name == 'it's' && open", "name == a) && open", "(name == a)) && open",
  "name == 'unclosed && open", "name ~ 'x' y", "name == (a) (b)", "name == a(b", "mekân == x", "çay ~ şeker", "$a == 1", "_b", "a1.b2 == 3", "1a == 2", "😀 == 1", "name == 😀", "name ~ 😀", "name == \n x", "name ==\tx", "name == x\ny", "name\n== x",
  "name == οδος σ", "name == οδοσ σ", "name ~ ΟΔΟΣ", "name ~ οδος", "name ~ σ", "status == κλειστός", "tags == i̇stanbul", "tags ~ İ", "tags == istanbul", "tags == straße", "tags == strasse", "tags ~ SS", "area == iğdir", "area == ığdır", "area ~ I",
  "name\u00a0==\u00a0Sofra", "name ==\u0085Sofra", "name == Sofra\u3000", "\ufeffopen", "open\u2028", "name == 'So\u00a0fra'", "name ~ \u0085",
  " ", "", "\n", "true", "false", "null", "!", "!!open", "! !open", "open!", "name == true", "name == false", "name == null", "name == 'null'", "name == .5", "name == 5.", "name == 1e3", "name == -1", "name == - 1", "name == +1", "name == 0x10",
  "rating >= 4.6 || (price==1 && !status)", "(open || rating>=4.6) && state.mode != 'off'", "((a == 1 || b == 2) && (c == 3 || d == 4)) || !(e)", "a == 1 && (b == 2", "a == 1 && b == 2)", "(a == (1)", "a == (1)", "a ~ (x) && (b)",
];

const OPS = ["==", "!=", "<", "<=", ">", ">=", "~", "=", "===", "!=="];
const FIELDS = ["name", "rating", "price", "tags", "status", "hours.until", "hours.closed", "id", "open", "flag", "list", "nested.a.b", "missing", "state.budget", "state.mode", "state.q"];
const VALUES = ["2", "4.5", "moda", "'Sofra'", '"rez"', "closed", "true", "false", "null", "state.budget", "state.q", "{state.min}", "00:00", "sea view", "(Moda)", "O'Brien", "''", "-1", "1e1"];
const NOISE = ["(", ")", "!", "&&", "||", "&", "|", "==", "=", "<", ">", "~", "'", '"', " ", " ", "open", "name", "price", "state.q", "2", "x", ".", "😀", "é", "{", "}", "\n"];

function randomFilter(rng, depth) {
  if (depth <= 0 || rng.chance(0.45)) {
    switch (rng.int(5)) {
      case 0: return rng.pick(["open", "!open"]);
      case 1: return `${rng.chance(0.5) ? "!" : ""}${rng.pick(FIELDS)}`;
      default: return `${rng.pick(FIELDS)}${rng.pick(["", " "])}${rng.pick(OPS)}${rng.pick(["", " "])}${rng.pick(VALUES)}`;
    }
  }
  const sub = () => randomFilter(rng, depth - 1);
  switch (rng.int(4)) {
    case 0: return `${sub()} && ${sub()}`;
    case 1: return `${sub()} || ${sub()}`;
    case 2: return `(${sub()})`;
    default: return `!(${sub()})`;
  }
}

export default function ({ call, scope }) {
  scope("whereItems", ITEMS);
  scope("whereState", STATE);
  for (const src of FILTERS) call("where", "whereAll", src);
  call("where", "whereAll", `${"a == 1 && ".repeat(49)}b == 2`);
  call("where", "whereAll", `${"a == 1 && ".repeat(50)}b == 2`);
  call("where", "whereAll", "é".repeat(501));
  for (const depth of [38, 39, 40, 41, 42]) {
    call("where", "whereAll", `${"(".repeat(depth)}open${")".repeat(depth)}`);
    call("where", "whereAll", `${"!(".repeat(depth)}open${")".repeat(depth)}`);
    call("where", "whereAll", `${"! (".repeat(depth)}open${")".repeat(depth)}`);
  }
  for (const item of [null, 5, "text", [], [{ name: "x" }]]) for (const src of ["open", "name", "!name", "name == x", "name != x", "name ~ x"]) call("where", "matchWhere", item, src, STATE);

  const rng = prng(0x77686572);
  for (let i = 0; i < 350; i++) call("where-fuzz", "whereAll", randomFilter(rng, 3));
  for (let i = 0; i < 250; i++) {
    let src = "";
    for (let n = 1 + rng.int(12); n > 0; n--) src += rng.pick(NOISE);
    call("where-fuzz", "whereAll", src);
  }
}
