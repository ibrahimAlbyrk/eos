import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  markupDepth,
  parseMarkup,
  parsePartial,
  tagLabel,
  walkMarkup,
  type MarkupElement,
  type MarkupNode,
} from "../genui/markup.ts";

const FIXTURES = new URL("./fixtures/genui/", import.meta.url);
const uiOf = (name: string): string => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")).ui;

const els = (nodes: MarkupNode[]): MarkupElement[] => nodes.filter((n): n is MarkupElement => n.type === "element");

function one(src: string): MarkupElement {
  const r = parseMarkup(src);
  assert.deepEqual(r.errors, []);
  const list = els(r.nodes);
  assert.equal(list.length, 1);
  return list[0];
}

describe("parseMarkup — attributes", () => {
  it("reads quoted, single-quoted, JSON, bare and flag values", () => {
    const el = one(`<Map of="places" pin='index' height={240} you route=true zoom=12 center={[40.98, 29.02]}/>`);
    assert.equal(el.name, "Map");
    assert.equal(el.selfClosing, true);
    assert.deepEqual(el.attrs, { of: "places", pin: "index", height: 240, you: true, route: "true", zoom: "12", center: [40.98, 29.02] });
  });

  it("keeps operators inside quoted values", () => {
    const el = one(`<Filters of="places" chips="Open: open, ₺–₺₺: price<=2, 4.5+: rating>=4.5"/>`);
    assert.equal(el.attrs.chips, "Open: open, ₺–₺₺: price<=2, 4.5+: rating>=4.5");
  });

  it("reads JSON forgivingly (single quotes, unquoted keys, trailing commas)", () => {
    const el = one(`<KeyValue items={{Battery: '18 h', "Weight": "1,24 kg",}}/>`);
    assert.deepEqual(el.attrs.items, { Battery: "18 h", Weight: "1,24 kg" });
  });

  it("JSON strings may hold apostrophes and braces", () => {
    const el = one(`<Choice bind="q" options={["Evet, olur", "Hayır — commit'leri yeniden yazar", "a {b}"]}/>`);
    assert.deepEqual(el.attrs.options, ["Evet, olur", "Hayır — commit'leri yeniden yazar", "a {b}"]);
  });

  it("decodes entities and escaped quotes in quoted values", () => {
    const el = one(`<Text title="say &quot;hi&quot; &amp; go" meta="a \\"b\\" c">x</Text>`);
    assert.equal(el.attrs.title, 'say "hi" & go');
    assert.equal(el.attrs.meta, 'a "b" c');
  });

  it("keeps templates as plain strings", () => {
    const el = one(`<Carousel of="places" meta="{cuisine} · {area}"/>`);
    assert.equal(el.attrs.meta, "{cuisine} · {area}");
  });

  it("records attribute positions", () => {
    const el = one(`<Card\n  of="places"\n  pick="moda"/>`);
    assert.deepEqual(el.attrPos.pick, { line: 3, col: 3, offset: 22 });
  });
});

describe("parseMarkup — structure", () => {
  it("nests children and keeps inline markdown text", () => {
    const r = parseMarkup(`<Section title="Today">\n  <Text>**Bold** and _soft_.</Text>\n  <Stack gap="sm">\n    <Badge tone="green">ok</Badge>\n  </Stack>\n</Section>`);
    assert.deepEqual(r.errors, []);
    const section = els(r.nodes)[0];
    assert.equal(section.name, "Section");
    const [text, stack] = els(section.children);
    assert.equal(text.text, "**Bold** and _soft_.");
    assert.equal(stack.name, "Stack");
    assert.equal(els(stack.children)[0].text, "ok");
    assert.equal(markupDepth(r.nodes), 3);
  });

  it("dedents multi-line text and keeps paragraphs", () => {
    const el = one(`<Hero of="places" pick="moda">\n    Deniz kenarında.\n\n    Masa ayırtmak iyi olur.\n  </Hero>`);
    assert.equal(el.text, "Deniz kenarında.\n\nMasa ayırtmak iyi olur.");
  });

  it("keeps a literal < in text", () => {
    const el = one(`<Text>a < b and 3 <= 4</Text>`);
    assert.equal(el.text, "a < b and 3 <= 4");
  });

  it("reads <Code> as raw text", () => {
    const el = one(`<Code lang="html">\n  <div class="x">{a}</div>\n  if (a < b) {}\n</Code>`);
    assert.equal(el.text, `<div class="x">{a}</div>\nif (a < b) {}`);
    assert.equal(el.children.length, 1);
  });

  it("skips comments", () => {
    const r = parseMarkup(`<!-- header -->\n<Divider/>\n<!-- end -->`);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(els(r.nodes).map((e) => e.name), ["Divider"]);
  });

  it("gives positions", () => {
    const r = parseMarkup(`<Stack>\n  <Text>a</Text>\n  <Map of="places"/>\n</Stack>`);
    const map = els(els(r.nodes)[0].children)[1];
    assert.deepEqual(map.pos, { line: 3, col: 3, offset: 27 });
  });

  it("walks every element with its depth and parent", () => {
    const r = parseMarkup(`<Tabs><Stack label="A"><Text>x</Text></Stack><Stack label="B"/></Tabs>`);
    const seen: string[] = [];
    walkMarkup(r.nodes, (el, depth, parent) => seen.push(`${el.name}@${depth}<${parent?.name ?? "-"}`));
    assert.deepEqual(seen, ["Tabs@1<-", "Stack@2<Tabs", "Text@3<Stack", "Stack@2<Tabs"]);
  });

  it("labels a tag with its identifying attributes", () => {
    assert.equal(tagLabel(one(`<Carousel of="places" skip="moda" card="compact"/>`)), '<Carousel of="places">');
    assert.equal(tagLabel(one(`<Card of="places" pick="moda"/>`)), '<Card of="places" pick="moda">');
    assert.equal(tagLabel(one(`<Grid cols="2"/>`)), "<Grid>");
  });
});

describe("parseMarkup — errors, never throws", () => {
  it("reports an element left open and closes it", () => {
    const r = parseMarkup(`<Section title="a">\n  <Text>x</Text>`);
    assert.deepEqual(r.errors, [{ message: "<Section> opened on line 1 is never closed", line: 1, col: 1 }]);
    assert.equal(els(els(r.nodes)[0].children)[0].text, "x");
  });

  it("reports a mismatched close and recovers", () => {
    const r = parseMarkup(`<Stack><Section><Text>x</Text></Stack><Divider/>`);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].message, /<Section> opened on line 1 is closed by <\/Stack>/);
    assert.deepEqual(els(r.nodes).map((e) => e.name), ["Stack", "Divider"]);
  });

  it("reports a stray close", () => {
    const r = parseMarkup(`<Divider/></Stack>`);
    assert.match(r.errors[0].message, /<\/Stack> has no matching open tag/);
  });

  it("reports bad JSON and keeps the raw text", () => {
    const r = parseMarkup(`<Chart type="bar" values={[1, 2,, oops]}/>`);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].message, /values=\{…\} is not valid JSON/);
    assert.equal(els(r.nodes)[0].attrs.values, "[1, 2,, oops]");
  });

  it("reports a repeated attribute", () => {
    const r = parseMarkup(`<Grid cols="2" cols="3"/>`);
    assert.match(r.errors[0].message, /repeats attribute cols/);
    assert.equal(els(r.nodes)[0].attrs.cols, "3");
  });

  it("reports an unfinished tag", () => {
    const r = parseMarkup(`<Text>a</Text><Card of="pla`);
    assert.ok(r.errors.some((e) => /never finished/.test(e.message)));
    assert.deepEqual(els(r.nodes).map((e) => e.name), ["Text"]);
  });

  it("survives garbage", () => {
    const inputs: unknown[] = [undefined, null, 7, {}, "", "<", "<<<>>>", "</", "<A", "<A b=", "<A b='", "<A b={", "<A b={{{}", "<!--", "</>", "><", "<A/><B></A></B>", "{}{}", "<1>", "<A =x>"];
    let seed = 7;
    const rand = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const alphabet = `<>/="'{}[] AaBb\n:,!-`;
    for (let i = 0; i < 300; i++) {
      let s = "";
      for (let k = 0; k < 40; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
      inputs.push(s);
    }
    for (const input of inputs) {
      assert.doesNotThrow(() => parseMarkup(input));
      assert.doesNotThrow(() => parsePartial(input));
    }
    assert.deepEqual(parseMarkup(42).errors, [{ message: "ui must be a string", line: 1, col: 1 }]);
  });

  it("does not let attribute names touch the prototype", () => {
    const el = one(`<Card __proto__="x" of="places"/>`);
    assert.equal(Object.getPrototypeOf(el.attrs), Object.prototype);
    assert.equal(el.attrs.__proto__, "x");
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });
});

// Every settled element of a partial parse equals the full parse's element at the
// same place; an open container's children follow the same rule.
function assertSettledPrefix(partial: MarkupNode[], full: MarkupNode[], where: string): void {
  const p = els(partial);
  const f = els(full);
  assert.ok(p.length <= f.length, `${where}: more elements than the full parse`);
  p.forEach((el, i) => {
    const target = f[i];
    assert.equal(el.name, target.name, `${where}: element ${i}`);
    if (el.partial) {
      assert.deepEqual(el.attrs, target.attrs, `${where}: attrs of open <${el.name}>`);
      assertSettledPrefix(el.children, target.children, `${where} > ${el.name}`);
    } else {
      assert.deepEqual(el, target, `${where}: settled <${el.name}> differs`);
    }
  });
}

describe("parsePartial — streaming", () => {
  it("drops an unclosed tail", () => {
    const r = parsePartial(`<Text>one</Text>\n<Text>tw`);
    assert.deepEqual(els(r.nodes).map((e) => e.text), ["one"]);
    assert.deepEqual(r.errors, []);
  });

  it("drops an unfinished start tag", () => {
    const r = parsePartial(`<Divider/>\n<Card of="places" pi`);
    assert.deepEqual(els(r.nodes).map((e) => e.name), ["Divider"]);
  });

  it("keeps an open container once it holds a closed element", () => {
    const r = parsePartial(`<Section title="Other">\n  <Card of="places" pick="lal"/>\n  <Card of="pla`);
    const section = els(r.nodes)[0];
    assert.equal(section.partial, true);
    assert.deepEqual(els(section.children).map((e) => e.attrs.pick), ["lal"]);
  });

  it("drops an open container with nothing settled inside", () => {
    assert.deepEqual(parsePartial(`<Section title="Other">\n  <Text>hal`).nodes, []);
  });

  it("drops trailing top-level text and an open <Code>", () => {
    assert.deepEqual(els(parsePartial(`<Divider/>\nSome trailing wor`).nodes).length, 1);
    assert.equal(parsePartial(`<Divider/>\nSome trailing wor`).nodes.length, 1);
    assert.deepEqual(els(parsePartial(`<Code lang="ts">const a = 1;\n</Co`).nodes), []);
  });

  for (const name of ["restaurants", "trip", "tests", "learn"]) {
    it(`renders ${name} progressively at every cut`, () => {
      const ui = uiOf(name);
      const full = parseMarkup(ui);
      assert.deepEqual(full.errors, []);
      let settled = 0;
      for (let cut = 0; cut <= ui.length; cut++) {
        const r = parsePartial(ui.slice(0, cut));
        assertSettledPrefix(r.nodes, full.nodes, `${name}@${cut}`);
        const count = els(r.nodes).filter((e) => !e.partial).length;
        assert.ok(count >= settled, `${name}@${cut}: settled elements went from ${settled} to ${count}`);
        settled = count;
      }
      assert.deepEqual(parsePartial(ui).nodes, full.nodes);
    });
  }
});
