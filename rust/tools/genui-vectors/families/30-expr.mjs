// The expression language and templates: parsing, evaluation over a fixed scope,
// and seeded random expressions.

import { prng } from "../lib/encode.mjs";

export const SCOPE = {
  item: { name: "Moda Kıyı", rating: 4.7, price: 2, tags: ["Sea", "meyhane"], hours: { until: "00:00", closed: false }, geo: [40.98, 29.02], n: "12", empty: "", zero: 0, nothing: null, title: "T" },
  state: { save: 3000, years: 5, party: 2, label: "x", on: true, off: false, budget: 2, text: "meyhane", list: [1, 2, 3] },
  data: {
    places: [
      { id: "moda", name: "Moda Kıyı", rating: 4.7, price: 2, tags: ["Sea"] },
      { id: "rihtim", name: "Rıhtım", rating: 4.4, price: 1, tags: [] },
      { id: "sofra", rating: "4.3", price: null },
    ],
    budget: [{ amount: 4500 }, { amount: 3200 }, { amount: 1700 }],
    rate: 0.2,
    matrix: [[1, 2], [3, [4, 5]]],
    obj: { name: "Named", title: "Titled", "2": "two" },
    untitled: { title: "Only title", name: null },
    mixed: [1, "2", true, null, "x", [3, "4"], { a: 1 }],
  },
};

const EXPRS = [
  "1", "1.5", ".5", "5.", "1e3", "1e-3", "1.e2", "1e", "1e+", "0x10", "1_000", "1e999", "1e999 - 1e999", "-1e999", "1.2.3", "1..2", ".", "..", "1.foo", "1 .5",
  "'a'", '"a"', "'it\\'s'", "'a\\nb\\tc\\\\d\\q'", "'unclosed", '"unclosed', "'a' 'b'", "'😀'", "'\\", "''",
  "true", "false", "null", "undefined", "True", "nothing", "name", "item", "state", "data", "item.name", "state.party", "data.rate", "data.places", "missing.deep.er", "name.length", "tags.length",
  "1 + 2 * 3", "(1 + 2) * 3", "10 - 4 - 3", "2 * -3 + +1", "7 % 4", "7 % 0", "1 / 0", "0 / 0", "-7 % 4", "7.5 % 2", "1 + '2'", "'1' + 2", "'a' + 1", "1 + 'a'", "'a' + 'b'", "'a' + null", "null + 1", "true + 1", "true + true", "'a' + true",
  "tags + 1", "tags + '!'", "hours + 'x'", "'x' + geo", "n * 2", "n + 1", "empty + 1", "'  3 ' * 2", "'1e2' + 1", "'0x10' + 1", "'-.5' * 2", "'5.' * 2", "'Infinity' + 1", "'1e999' + 1", "'1e999' * 0",
  "3 > 2", "2 >= 2", "1 < '2'", "'10' < '9'", "'b' > 'a'", "'a' < 'B'", "'￿' < '😀'", "true < 2", "null < 1", "'a' < 1", "tags < 1", "1 == '1'", "1 == 1.0", "'a' == 'a'", "'a' == 'A'", "true == 1", "true == true", "null == nothing",
  "null == 0", "null == false", "null == ''", "tags == tags", "hours == hours", "'1' == '1.0'", "1 != 2", "'a' != 'b'", "1 === 1", "1 !== 2", "1 = 1", "1 <> 2", "1 => 2", "!0", "!1", "!''", "!'a'", "!tags", "!empty", "!nothing", "!hours", "!!name",
  "0 || 'fallback'", "'' || 0 || null", "1 && 2", "0 && 2", "null && x", "tags && 'has'", "zero || 'z'", "1 || missing()", "a ? b : c", "party > 4 ? 'big' : 'small'", "1 ? 2 ? 3 : 4 : 5", "0 ? 1 : 0 ? 2 : 3", "1 ? 2", "1 ? : 2", "? 1 : 2", "1 ?: 2",
  "data.places.rating", "data.places.name", "data.places.tags", "data.places.missing", "data.budget.amount", "data.matrix", "data.matrix.x", "data.places[0]", "data.places[0].name", "data.places[-1].id", "data.places[1.9].id", "data.places[3]", "data.places[-4]",
  "data.places['0']", "data.places['name']", "data.obj[2]", "data.obj['2']", "data.obj['name']", "data.obj[true]", "data.obj[null]", "tags[0]", "tags[1 - 1]", "tags[state.party - 1]", "geo[0] + geo[1]", "name[0]", "data.matrix[1][1][0]", "data.places[0]['tags'][0]",
  "sum(data.budget.amount)", "sum(1, 2, 3)", "sum()", "sum('4', true, null, 'x', [1, [2]])", "sum(data.mixed)", "count(data.places)", "count(data.mixed)", "count()", "count(0, '', null, false, true, 'a', [])", "min(data.places.rating)", "max(data.places.rating)",
  "min()", "max()", "min(3, '1', 2)", "max(-0, 0)", "min(0, -0)", "avg(data.places.price)", "avg()", "avg(1, 2)", "round(4.567)", "round(4.567, 1)", "round(4.567, 2)", "round(-2.5)", "round(2.5)", "round(0.5)", "round(-0.5)", "round(1.005, 2)", "round(1234.5678, -2)",
  "round(1.23456789012, 20)", "round('x')", "round(1, 'x')", "round(1e308, 10)", "round(0.49999999999999994)", "abs(-3)", "abs('x')", "abs()", "floor(-1.5)", "floor(1.5)", "ceil(1.2)", "ceil(-1.2)", "ceil(null)",
  "fv(3000, 0.2, 5)", "fv(save, data.rate, years)", "fv(100, 0, 2)", "fv(100, 0.12, 0)", "fv(100, 0.12, -1)", "fv(100, 0.12, 0.04)", "fv(100, 0.12)", "fv('a', 1, 1)", "fv(1, 12, 100)", "fv(250, 0.07, 30)", "fv(1, -12, 1)", "fv(1, -24, 3)",
  "alert(1)", "sum.x", "sum", "data.sum(1)", "(sum)(1)", "sum(1)(2)", "name()", "name.toString()", "constructor", "__proto__", "prototype", "name.constructor", "data.__proto__", "item.prototype", "data['__proto__']", "data['constructor']", "data.places['constructor']",
  "(", ")", "()", "(1", "1)", "((1))", "[1]", "1 +", "+ 1", "* 1", "1 * * 2", "1 2", "a b", "a.", "a.1", "a..b", "a[", "a[]", "a[1", "a]", "sum(1,)", "sum(,1)", "sum(1 2)", ",", "1,2", "a ? b", "!", "-", "- - 1", "+ + 1", "!-1", "-!1", "- 'a'", "+ '3'", "+true", "-null",
  "a & b", "a | b", "a ^ b", "a ~ b", "#", "@x", "a;b", "{a}", "`a`", "a\nb", "a\t+ b", "mekân + 1", "çay.şeker", "$a + _b", "a$b", "😀", "a😀", "𝒜", "x٣", "٣", "é1", "１２", "x１",
  "a\u0085b", "\ufeff1", "1\u2028+\u20292", "a\u200bb", "\u00a0", "\u0085", "\u3000 1 \u3000", "'a\u0085'", "name\u00a0.\u00a0length",
  "'ΟΔΟΣ' == 'οδος'", "'İ' + 'i'", "'ß' < 'ss'", "'a' < 'ä'", "'Z' < 'a'", "'\ud7ff' < '\ue000'", "'😀' < '\ue000'", "'😀' > 'z'",
  " ", "", "\n", "1 /* c */", "a // b", "a ?? b", "a?.b", "a ** 2", "a++", "typeof a", "new a", "a in b", "a = 1", "a += 1", "a, b", "a => a", "...a", "1 < 2 < 3", "1 == 1 == 1", "!1 == 0", "-2 * 3 > -7 && 1",
  "1 ? 2 : 3 ? 4 : 5", "a || b && c", "a && b || c", "(a || b) && c", "1 + 2 == 3", "1 + (2 == 3)", "2 * 3 % 4", "2 + 3 > 4 == true", "state.list[0] + state.list[1] * state.list[2]", "state.list", "state.list.x", "data.mixed.a",
];

const TEMPLATES = [
  "", "plain", "{name}", "{ name }", "{name} · {rating}", "{price * 2}", "{state.party}", "{data.rate}", "{missing}", "{nothing}", "{tags}", "{geo}", "{hours}", "{data.obj}", "{data.untitled}", "{data.places}", "{data.places.rating}",
  "{data.mixed}", "{on} {off}", "{{literal}}", "{{{name}}}", "}}{{", "{", "}", "{}", "{ }", "{a{b}c}", "{name", "name}", "{1 +}", "{not an expr}", "{'x'}", "{\"q\"}", "{name} {", "{name}}", "{{name}", "a{b}c{d}e", "{geo[0]}, {geo[1]}",
  "\u00a0{name}\u00a0", "{\u00a0name\u00a0}", "{\u0085}", "{\u0085name}", "{\u3000}", "{\ufeff}", "{\u200b}",
  "{sum(data.budget.amount)}", "{1/3}", "{1e21}", "{0.1 + 0.2}", "{-0}", "{1e-7}", "{data.matrix}", "{state.list}", "{empty}", "{zero}", "😀 {name} 😀", "{'😀'}", "{name\n}", "{\tname\t}", "{{", "}}", "{{}}", "{}}", "{{}", "{ {name} }",
];

const ATOMS = ["1", "2.5", "0", "'a'", "'12'", "''", "true", "false", "null", "name", "rating", "price", "tags", "geo", "hours", "n", "empty", "zero", "nothing", "missing", "item.rating", "state.party", "state.save", "state.on", "state.list", "data.rate", "data.places",
  "data.places.rating", "data.budget.amount", "data.matrix", "data.mixed", "data.obj", "tags[0]", "geo[1]", "data.places[0].rating", "data.places[-1].price"];
const BINARY = ["+", "-", "*", "/", "%", "<", "<=", ">", ">=", "==", "!=", "&&", "||"];
const FUNCTIONS = ["sum", "count", "min", "max", "avg", "round", "abs", "floor", "ceil", "fv"];
const NOISE = ["(", ")", "[", "]", ".", ",", "?", ":", "!", "-", "+", "*", "/", "%", "<", ">", "=", "&", "|", "'", '"', " ", "a", "b1", "sum", "1", ".5", "e", "😀", "é", "_", "$", "\\"];

function randomExpr(rng, depth) {
  if (depth <= 0 || rng.chance(0.3)) return rng.pick(ATOMS);
  const sub = () => randomExpr(rng, depth - 1);
  switch (rng.int(7)) {
    case 0: return `${sub()} ${rng.pick(BINARY)} ${sub()}`;
    case 1: return `(${sub()})`;
    case 2: return `${rng.pick(["!", "-", "+"])}${sub()}`;
    case 3: return `${sub()} ? ${sub()} : ${sub()}`;
    case 4: return `${rng.pick(FUNCTIONS)}(${Array.from({ length: rng.int(4) }, sub).join(", ")})`;
    case 5: return `${rng.pick(ATOMS)}[${sub()}]`;
    default: return `${sub()} ${rng.pick(BINARY)} ${sub()}`;
  }
}

export default function ({ call, scope }) {
  scope("expr", SCOPE);
  for (const src of EXPRS) call("expr", "exprAll", src);
  call("expr", "exprAll", `${"x + ".repeat(124)}x`);
  call("expr", "exprAll", `${"x + ".repeat(125)}x`);
  call("expr", "exprAll", "😀".repeat(251));
  for (const depth of [12, 13, 14, 19, 20, 21, 39, 40, 41, 42]) {
    for (const [open, close] of [["(", ")"], ["!", ""], ["-", ""], ["a[", "]"], ["sum(", ")"], ["1 ? ", " : 2"], ["1 + (", ")"], ["0 ? 1 : ", ""]]) {
      call("expr", "exprAll", `${open.repeat(depth)}1${close.repeat(depth)}`);
    }
  }
  for (const value of [null, true, false, 0, -0, 1, "", "a", "0", [], [0], {}, { a: 1 }]) call("expr", "truthy", value);
  for (const t of TEMPLATES) call("expr", "templateAll", t);

  const rng = prng(0x65787072);
  for (let i = 0; i < 500; i++) call("expr-fuzz", "exprAll", randomExpr(rng, 4));
  for (let i = 0; i < 300; i++) {
    let src = "";
    for (let n = 1 + rng.int(14); n > 0; n--) src += rng.pick(NOISE);
    call("expr-fuzz", "exprAll", src);
    call("expr-fuzz", "templateAll", `a {${src}} b`);
  }
}
