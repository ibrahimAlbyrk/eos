import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkExpr,
  checkWhere,
  evalExpr,
  exprRefs,
  fillTemplate,
  hasTemplate,
  matchWhere,
  parseExpr,
  parseWhere,
  whereReadsState,
  type ExprScope,
  type WhereNode,
} from "../genui/expr.ts";

const places = [
  { id: "moda", name: "Moda Kıyı", rating: 4.7, price: 2, tags: ["Sea", "meyhane"], hours: { until: "00:00" }, area: "Moda" },
  { id: "rihtim", name: "Rıhtım", rating: 4.4, price: 1, tags: [], hours: { until: "21:00" }, status: "closing" },
  { id: "sofra", name: "Sofra", rating: 4.3, price: 2, tags: ["rez"], hours: { closed: true } },
  { id: "yel", name: "Yel", rating: 4.6, price: 3, tags: ["meyhane", "rez"], status: "Closed" },
];
const scope: ExprScope = { state: { save: 3000, years: 5, party: 2, label: "x" }, data: { places, budget: [{ amount: 4500 }, { amount: 3200 }, { amount: 1700 }], rate: 0.2 } };

describe("evalExpr — the language", () => {
  it("does arithmetic with precedence and parentheses", () => {
    assert.equal(evalExpr("1 + 2 * 3"), 7);
    assert.equal(evalExpr("(1 + 2) * 3"), 9);
    assert.equal(evalExpr("10 - 4 - 3"), 3);
    assert.equal(evalExpr("2 * -3 + +1"), -5);
    assert.equal(evalExpr("7 % 4"), 3);
    assert.equal(evalExpr("1 / 0"), null);
    assert.equal(evalExpr(".5 + 1e1"), 10.5);
  });

  it("compares, combines and branches", () => {
    assert.equal(evalExpr("3 > 2 && 2 >= 2"), true);
    assert.equal(evalExpr("1 == '1'"), true);
    assert.equal(evalExpr("'a' != 'b'"), true);
    assert.equal(evalExpr("!0 || false"), true);
    assert.equal(evalExpr("party > 4 ? 'big' : 'small'", scope), "small");
    assert.equal(evalExpr("0 || 'fallback'"), "fallback");
    assert.equal(evalExpr("'b' > 'a'"), true);
    assert.equal(evalExpr("null == missing", scope), true);
  });

  it("joins text with +", () => {
    assert.equal(evalExpr("'₺' + 12"), "₺12");
    assert.equal(evalExpr("label + '!'", scope), "x!");
  });

  it("resolves item fields, then state, then data", () => {
    const s: ExprScope = { item: { party: 9 }, state: { party: 2 }, data: { party: 1 } };
    assert.equal(evalExpr("party", s), 9);
    assert.equal(evalExpr("state.party", s), 2);
    assert.equal(evalExpr("data.party", s), 1);
    assert.equal(evalExpr("item.party", s), 9);
    assert.equal(evalExpr("nothing", s), null);
  });

  it("maps a member over a list and indexes", () => {
    assert.deepEqual(evalExpr("places.rating", scope), [4.7, 4.4, 4.3, 4.6]);
    assert.equal(evalExpr("places[0].name", scope), "Moda Kıyı");
    assert.equal(evalExpr("places[-1].id", scope), "yel");
    assert.equal(evalExpr("places[0]['area']", scope), "Moda");
  });

  it("runs the whitelisted functions", () => {
    assert.equal(evalExpr("sum(budget.amount)", scope), 9400);
    assert.equal(evalExpr("count(places)", scope), 4);
    assert.equal(evalExpr("count(places.status)", scope), 2);
    assert.equal(evalExpr("min(places.price)", scope), 1);
    assert.equal(evalExpr("max(places.rating)", scope), 4.7);
    assert.equal(evalExpr("round(avg(places.rating), 2)", scope), 4.5);
    assert.equal(evalExpr("round(2.5)"), 3);
    assert.equal(evalExpr("abs(-2) + floor(1.9) + ceil(1.1)"), 5);
    assert.equal(evalExpr("sum(1, 2, '3', 'x')"), 6);
    assert.equal(evalExpr("max()"), null);
    assert.equal(evalExpr("round(fv(save, rate, years))", scope), 305275);
    assert.equal(evalExpr("fv(100, 0, 1)"), 1200);
  });
});

describe("evalExpr — safety", () => {
  it("rejects calls outside the whitelist and anything that is not an expression", () => {
    for (const src of [
      "alert(1)",
      "eval('1')",
      "Function('return 1')()",
      "process.exit()",
      "places.map(1)",
      "constructor",
      "a.constructor",
      "x.__proto__",
      "a.prototype",
      "a = 1",
      "`x`",
      "[].length",
      "new Date()",
      "x => x",
      "a; b",
      "import('x')",
      "1 +",
      "(1",
      "",
      "x".repeat(501),
      "(".repeat(100) + "1" + ")".repeat(100),
    ]) {
      assert.ok(checkExpr(src), `accepted ${JSON.stringify(src.slice(0, 40))}`);
      assert.equal(evalExpr(src, scope), null);
    }
    assert.match(checkExpr("alert(1)") ?? "", /^unknown function alert\(\) — allowed: sum, count, min, max, avg, round/);
  });

  it("never reads inherited properties", () => {
    assert.equal(evalExpr("toString", { state: {} }), null);
    assert.equal(evalExpr("x.toString", { state: { x: {} } }), null);
    assert.equal(evalExpr("x['__proto__']", { state: { x: {} } }), null);
    assert.equal(evalExpr("x['constructor']", { state: { x: {} } }), null);
    assert.equal(evalExpr("globalThis", {}), null);
    assert.equal(evalExpr("globalThis.process", {}), null);
  });

  it("never throws on hostile input", () => {
    for (const v of [undefined, null, 5, {}, "((((", "'", "\"unterminated", "1..2", "a.b.c.d.e", "sum(" + "1,".repeat(1000) + "1)"]) {
      assert.doesNotThrow(() => evalExpr(v as string, scope));
      assert.doesNotThrow(() => parseExpr(v));
    }
  });

  it("lists what an expression reads", () => {
    assert.deepEqual(exprRefs("fv(save, 0.2, years) + state.extra + data.places[0].rating + item.price").sort(), [
      "data.places",
      "item.price",
      "save",
      "state.extra",
      "years",
    ]);
  });
});

describe("fillTemplate", () => {
  const item = { name: "Moda Kıyı", cuisine: "Meyhane", area: "Moda", geo: [40.981, 29.025], tags: ["sea", "rez"], price: 2 };
  it("fills item fields, state and expressions", () => {
    assert.equal(fillTemplate("{cuisine} · {area}", { item }), "Meyhane · Moda");
    assert.equal(fillTemplate("Book {name} for {state.party}", { item, state: { party: 2 } }), "Book Moda Kıyı for 2");
    assert.equal(fillTemplate("maps:{geo}", { item }), "maps:40.981,29.025");
    assert.equal(fillTemplate("{tags}", { item }), "sea, rez");
    assert.equal(fillTemplate("{price * 1000}", { item }, { formatNumber: (n) => n.toLocaleString("en-US") }), "2,000");
  });

  it("prints nothing for a missing value and keeps non-expressions", () => {
    assert.equal(fillTemplate("{missing}!", { item }), "!");
    assert.equal(fillTemplate("set {a b} here", { item }), "set {a b} here");
    assert.equal(fillTemplate("{{literal}} braces }}", { item }), "{literal} braces }");
    assert.equal(fillTemplate("no holes", {}), "no holes");
    assert.equal(fillTemplate(undefined), "");
    assert.equal(fillTemplate("open { brace", {}), "open { brace");
  });

  it("detects templates", () => {
    assert.equal(hasTemplate("{rating}"), true);
    assert.equal(hasTemplate("{ rating }"), true);
    assert.equal(hasTemplate("plain"), false);
    assert.equal(hasTemplate("{}"), false);
    assert.equal(hasTemplate(4), false);
  });
});

describe("where", () => {
  const pass = (where: string, state?: unknown): string[] => places.filter((p) => matchWhere(p, where, state)).map((p) => p.id);

  it("open = not closed by hours or status", () => {
    assert.deepEqual(pass("open"), ["moda", "rihtim"]);
    assert.deepEqual(pass("!open"), ["sofra", "yel"]);
  });

  it("compares numbers and text", () => {
    assert.deepEqual(pass("price<=2"), ["moda", "rihtim", "sofra"]);
    assert.deepEqual(pass("rating >= 4.5"), ["moda", "yel"]);
    assert.deepEqual(pass("name == 'rıhtım'"), ["rihtim"]);
    assert.deepEqual(pass("area != Moda"), ["rihtim", "sofra", "yel"]);
    assert.deepEqual(pass("hours.until > 20:00"), ["rihtim"]);
    assert.deepEqual(pass("price = 3"), ["yel"]);
  });

  it("~ contains, case-insensitive, and any element of a list", () => {
    assert.deepEqual(pass("tags~sea"), ["moda"]);
    assert.deepEqual(pass("tags ~ REZ"), ["sofra", "yel"]);
    assert.deepEqual(pass("name~kıy"), ["moda"]);
  });

  it("truthy fields and && combinations", () => {
    assert.deepEqual(pass("status"), ["rihtim", "yel"]);
    assert.deepEqual(pass("!status && price<=2"), ["moda", "sofra"]);
    assert.deepEqual(pass("open && tags~meyhane && rating>=4.5"), ["moda"]);
  });

  it("reads state.key on the right", () => {
    assert.deepEqual(pass("price == state.budget", { budget: 2 }), ["moda", "sofra"]);
    assert.deepEqual(pass("price == {state.budget}", { budget: 1 }), ["rihtim"]);
    assert.deepEqual(pass("price == state.none", {}), []);
  });

  it("reads state.key on the left too", () => {
    assert.deepEqual(pass("state.mode == 'Sea' && tags~sea", { mode: "sea" }), ["moda"]);
    assert.deepEqual(pass("state.mode == 'Sea'", {}), []);
    assert.deepEqual(pass("state.all || price<=1", { all: false }), ["rihtim"]);
    assert.deepEqual(pass("!state.all && price<=1", {}), ["rihtim"]);
    assert.deepEqual(pass("state.cap >= state.min", { cap: 3, min: 2 }), ["moda", "rihtim", "sofra", "yel"]);
  });

  it("|| joins clauses, && binds tighter, ( ) and !( ) group", () => {
    assert.deepEqual(pass("open || rating>4.5"), ["moda", "rihtim", "yel"]);
    assert.deepEqual(pass("price==3 || open && price==1"), ["rihtim", "yel"]);
    assert.deepEqual(pass("(price==3 || open) && price<=2"), ["moda", "rihtim"]);
    assert.deepEqual(pass("!(open || price==3)"), ["sofra"]);
    assert.deepEqual(pass("!(!open)"), ["moda", "rihtim"]);
    assert.deepEqual(pass(" ( ( tags~rez ) ) && !(status)"), ["sofra"]);
    assert.deepEqual(pass("id != 'moda' || state.mode == 'all'", { mode: "all" }), ["moda", "rihtim", "sofra", "yel"]);
    assert.deepEqual(pass("id != 'moda' || state.mode == 'all'", { mode: "one" }), ["rihtim", "sofra", "yel"]);
  });

  it("keeps && || ( ) inside quotes and parentheses inside bare values", () => {
    const items = [
      { id: "a", name: "Fish && Chips" },
      { id: "b", name: "Tea || Coffee" },
      { id: "c", name: "Kebap (Moda)" },
      { id: "d", name: "O'Brien" },
    ];
    const ids = (where: string): string[] => items.filter((it) => matchWhere(it, where)).map((it) => it.id);
    assert.deepEqual(ids("name == 'Fish && Chips'"), ["a"]);
    assert.deepEqual(ids('name == "Tea || Coffee" || id == c'), ["b", "c"]);
    assert.deepEqual(ids("name == Kebap (Moda)"), ["c"]);
    assert.deepEqual(ids("(name == Kebap (Moda) || id == a)"), ["a", "c"]);
    assert.deepEqual(ids("(name == 'a)' || id == b)"), ["b"]);
    assert.deepEqual(ids("name == O'Brien || id == a"), ["a", "d"]);
    // A quote that never closes is plain text.
    assert.deepEqual(ids("name ~ 'brien && id == d"), ["d"]);
  });

  it("rejects what it can't read, and then filters nothing", () => {
    const bad = ["", "price <", "rating >> 4", "&& open", "open ||", "open || || price<2", "1 == 1", "price(2)", "(open", "open)", "(open))", "(open) price<2", "()", "!price<=2", "!(open"];
    for (const src of bad) assert.ok(checkWhere(src), `accepted ${JSON.stringify(src)}`);
    assert.match(checkWhere("(open || price<2") ?? "", /"\(" at 1 is never closed/);
    assert.match(checkWhere("(open))") ?? "", /"\)" at 7 has no "\("/);
    assert.match(checkWhere("(open) price<2") ?? "", /expected && or \|\| before "price<2" at 8/);
    assert.match(checkWhere("open || ") ?? "", /empty clause/);
    assert.equal(checkWhere("open && tags~sea"), null);
    assert.equal(checkWhere("open)"), "\"open)\" is not a filter — use open, field, !field or field op value (op: == != < <= > >= ~), joined with && or ||, grouped with ( )");
    assert.equal(matchWhere(places[2], "price <"), true);
    const r = parseWhere("tags~sea && price<=2");
    assert.ok(r.ok);
    assert.deepEqual(r.node, {
      op: "and",
      of: [
        { op: "~", field: "tags", value: "sea" },
        { op: "<=", field: "price", value: 2 },
      ],
    });
  });

  it("parses into a tree", () => {
    const tree = (src: string): unknown => {
      const r = parseWhere(src);
      assert.ok(r.ok, src);
      return r.node;
    };
    assert.deepEqual(tree("open"), { op: "open" });
    assert.deepEqual(tree("a || b && !c"), {
      op: "or",
      of: [
        { op: "truthy", field: "a" },
        { op: "and", of: [{ op: "truthy", field: "b" }, { op: "truthy", field: "c", not: true }] },
      ],
    });
    assert.deepEqual(tree("!(a || b)"), { op: "or", of: [{ op: "truthy", field: "a" }, { op: "truthy", field: "b" }], not: true });
    assert.deepEqual(tree("!(!open)"), { op: "open" });
    assert.deepEqual(tree("state.x == state.y"), { op: "==", lref: "x", ref: "y" });
    assert.equal(whereReadsState(tree("open || (price<2 && day == {state.day})") as WhereNode), true);
    assert.equal(whereReadsState(tree("open || !state.all") as WhereNode), true);
    assert.equal(whereReadsState(tree("open || (price<2 && state == CA)") as WhereNode), false);
  });
});
