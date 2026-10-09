import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLooseJson, parsePartialJson } from "../genui/partial-json.ts";

const FIXTURES = new URL("./fixtures/genui/", import.meta.url);
const NAMES = ["restaurants", "trip", "tests", "learn", "app"] as const;
const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);

// Everything a partial parse returns must already be true of the full document:
// settled values equal, arrays a prefix of whole elements, streaming strings a prefix.
function assertConsistent(partial: unknown, full: unknown, path: string, topLevel: boolean, partialKeys: ReadonlySet<string>): void {
  if (isObj(partial)) {
    assert.ok(isObj(full), `${path}: object vs ${typeof full}`);
    for (const [k, v] of Object.entries(partial)) {
      assert.ok(k in full, `${path}.${k}: key not in the full document`);
      const fv: unknown = full[k];
      if (typeof v === "string" && topLevel && partialKeys.has(k)) {
        assert.ok(typeof fv === "string" && fv.startsWith(v), `${path}.${k}: not a prefix`);
      } else if (isObj(v) || Array.isArray(v)) {
        assertConsistent(v, fv, `${path}.${k}`, false, partialKeys);
      } else {
        assert.deepEqual(v, fv, `${path}.${k}`);
      }
    }
    return;
  }
  if (Array.isArray(partial)) {
    assert.ok(Array.isArray(full), `${path}: array vs ${typeof full}`);
    assert.ok(partial.length <= full.length, `${path}: longer than the full array`);
    partial.forEach((v, i) => assert.deepEqual(v, full[i], `${path}[${i}] is not a whole element`));
    return;
  }
  assert.deepEqual(partial, full, path);
}

function rows(v: unknown): number {
  if (!isObj(v) || !isObj(v.data)) return 0;
  return Object.values(v.data).reduce<number>((n, c) => n + (Array.isArray(c) ? c.length : 0), 0);
}

describe("parsePartialJson — every cut of the scenario fixtures", () => {
  const keys = new Set(["ui"]);
  for (const name of NAMES) {
    for (const pretty of [false, true]) {
      it(`${name} (${pretty ? "pretty" : "compact"})`, () => {
        const doc = load(name);
        const text = pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc);
        let lastRows = 0;
        let lastUi = 0;
        for (let cut = 0; cut <= text.length; cut++) {
          const r = parsePartialJson(text.slice(0, cut));
          assert.equal(r.error, undefined, `${name}@${cut}: ${r.error}`);
          if (r.value !== undefined) assertConsistent(r.value, doc, `${name}@${cut}`, true, keys);
          const n = rows(r.value);
          assert.ok(n >= lastRows, `${name}@${cut}: rows went back`);
          lastRows = n;
          const ui = isObj(r.value) && typeof r.value.ui === "string" ? r.value.ui.length : 0;
          assert.ok(ui >= lastUi, `${name}@${cut}: ui went back`);
          lastUi = ui;
          if (cut < text.length) assert.equal(r.complete, false, `${name}@${cut}: complete too early`);
        }
        const done = parsePartialJson(text);
        assert.equal(done.complete, true);
        assert.deepEqual(done.value, doc);
      });
    }
  }
});

describe("parsePartialJson — rules", () => {
  it("drops a string still being written, except ui", () => {
    assert.deepEqual(parsePartialJson('{"title":"Kad').value, {});
    assert.deepEqual(parsePartialJson('{"title":"Kadıköy","ui":"<Map of=\\"pla').value, { title: "Kadıköy", ui: '<Map of="pla' });
  });

  it("keeps only whole rows in arrays and settled keys in nested objects", () => {
    const r = parsePartialJson('{"data":{"places":[{"id":"a","rating":4.5},{"id":"b","name":"Lâl');
    assert.deepEqual(r.value, { data: { places: [{ id: "a", rating: 4.5 }] } });
    const s = parsePartialJson('{"actions":{"book":{"label":"Masa","kind":"se');
    assert.deepEqual(s.value, { actions: { book: { label: "Masa" } } });
  });

  it("drops a number or literal at the very end", () => {
    assert.deepEqual(parsePartialJson('{"rating":4').value, {});
    assert.deepEqual(parsePartialJson('{"rating":4.7,').value, { rating: 4.7 });
    assert.deepEqual(parsePartialJson('{"primary":tr').value, {});
    assert.deepEqual(parsePartialJson('{"primary":true').value, { primary: true });
    assert.deepEqual(parsePartialJson('{"x":nu').value, {});
  });

  it("handles escapes cut in the middle", () => {
    assert.deepEqual(parsePartialJson('{"ui":"a\\').value, { ui: "a" });
    assert.deepEqual(parsePartialJson('{"ui":"a\\u00').value, { ui: "a" });
    assert.deepEqual(parsePartialJson('{"ui":"a\\u00e7b').value, { ui: "açb" });
    assert.deepEqual(parsePartialJson('{"ui":"line\\nnext"}').value, { ui: "line\nnext" });
    assert.deepEqual(parsePartialJson(`{"ui":"x${"\uD83D"}`).value, { ui: "x" });
  });

  it("honours partialKeys and only at the top level", () => {
    assert.deepEqual(parsePartialJson('{"html":"<div', { partialKeys: ["html"] }).value, { html: "<div" });
    assert.deepEqual(parsePartialJson('{"data":{"ui":"<Ma').value, { data: {} });
  });

  it("reports a real syntax error and keeps what came before", () => {
    const r = parsePartialJson('{"title":"a","tone" "blue"}');
    assert.match(r.error ?? "", /expected ":"/);
    assert.deepEqual(r.value, { title: "a" });
    assert.equal(r.complete, false);
  });

  it("is complete only for a whole document", () => {
    assert.deepEqual(parsePartialJson('{"a":[1,2]}'), { value: { a: [1, 2] }, complete: true });
    assert.equal(parsePartialJson("").value, undefined);
    assert.equal(parsePartialJson("   ").complete, false);
    assert.match(parsePartialJson('{"a":1} x').error ?? "", /after the value/);
    assert.equal(parsePartialJson(5).error, "input is not a string");
  });

  it("never touches the prototype", () => {
    const r = parsePartialJson('{"__proto__":{"polluted":1},"a":1}');
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.ok(Object.prototype.hasOwnProperty.call(r.value, "__proto__"));
  });

  it("survives garbage", () => {
    for (const s of ["{", "[", '{"', '{"a"', '{"a":', "[1,", '{"a":[{"b":', "]]]", "{{", "nul", "-", '"\\', "{,}", "[,]", '{"a":1,,}']) {
      assert.doesNotThrow(() => parsePartialJson(s));
    }
    const deep = "[".repeat(5000);
    assert.doesNotThrow(() => parsePartialJson(deep));
  });
});

describe("parseLooseJson", () => {
  it("reads strict JSON", () => {
    assert.deepEqual(parseLooseJson('{"a":[1,true,null,"x"]}'), { ok: true, value: { a: [1, true, null, "x"] } });
    assert.deepEqual(parseLooseJson("-1.5e2"), { ok: true, value: -150 });
  });

  it("forgives single quotes, unquoted keys, trailing commas and comments", () => {
    assert.deepEqual(parseLooseJson("{a: 'x', 'b-c': [1, 2,], /* note */ d: \"y\", // tail\n}"), {
      ok: true,
      value: { a: "x", "b-c": [1, 2], d: "y" },
    });
  });

  it("rejects incomplete or broken input with a position", () => {
    const r = parseLooseJson('{"a": [1, 2}');
    assert.equal(r.ok, false);
    assert.equal(r.ok ? 0 : r.at, 11);
    assert.deepEqual(parseLooseJson('{"a": 1'), { ok: false, error: "unexpected end of JSON", at: 7 });
    assert.equal(parseLooseJson("{a: 1} extra").ok, false);
    assert.equal(parseLooseJson("NaN").ok, false);
    assert.equal(parseLooseJson(undefined).ok, false);
  });
});
