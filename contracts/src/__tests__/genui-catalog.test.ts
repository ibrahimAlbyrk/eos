import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMPONENT_NAMES,
  COMPONENT_SCHEMAS,
  GENUI_LIMITS,
  formatProblems,
  statsLine,
  validateView,
  type ViewProblem,
  type ViewValidation,
} from "../genui/catalog.ts";
import { PresentAppInputSchema, PresentInputSchema, presentSuccessText, validateApp } from "../genui/spec.ts";

const FIXTURES = new URL("./fixtures/genui/", import.meta.url);
const VIEWS = ["restaurants", "trip", "tests", "learn"] as const;

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));
}

function problemsOf(r: ViewValidation): ViewProblem[] {
  assert.equal(r.ok, false, "expected the spec to be rejected");
  return r.ok ? [] : r.problems;
}

function hasProblem(r: ViewValidation, path: string, message: string | RegExp): void {
  const ps = problemsOf(r);
  const hit = ps.find((p) => p.path === path && (typeof message === "string" ? p.message === message : message.test(p.message)));
  assert.ok(hit, `no problem ${path}: ${message}\ngot:\n${ps.map((p) => `${p.path}: ${p.message}`).join("\n")}`);
}

function withUi(ui: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const spec = fixture("restaurants");
  return { ...spec, ui, ...extra };
}

describe("scenario fixtures", () => {
  for (const name of VIEWS) {
    it(`${name} validates with no problems or warnings`, () => {
      const spec = fixture(name);
      const r = validateView(spec);
      assert.equal(r.ok, true, r.ok ? "" : formatProblems(r.problems));
      assert.deepEqual(r.warnings, []);
      assert.equal(PresentInputSchema.safeParse(spec).success, true);
    });
  }

  it("the app fixture validates", () => {
    const spec = fixture("app");
    const r = validateApp(spec);
    assert.equal(r.ok, true);
    assert.equal(PresentAppInputSchema.safeParse(spec).success, true);
  });

  it("reports stats the tool line uses", () => {
    const r = validateView(fixture("restaurants"));
    assert.ok(r.ok);
    assert.equal(r.stats.maps, 1);
    assert.equal(r.stats.primaryActions, 1);
    assert.deepEqual(r.stats.collections[0], { name: "places", count: 6, type: "Place" });
    assert.equal(statsLine(r.stats), "6 places");
    assert.equal(presentSuccessText("v_7Hq2abcdEFGH", r.stats, { unresolvedImages: 2 }), "view v_7Hq2abcdEFGH rendered · 6 places · 2 images unresolved → monograms");
  });
});

describe("limits — each rejected with its path", () => {
  it("rating outside 0–5", () => {
    const spec = fixture("restaurants");
    spec.data.places[3].rating = 6.2;
    hasProblem(validateView(spec), "data.places[3].rating", "6.2 is outside 0–5");
  });

  it("Carousel above 8 items", () => {
    const spec = fixture("restaurants");
    const extra = Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, type: "Place", name: `Extra ${i}`, geo: [40.98, 29.02] }));
    spec.data.places.push(...extra);
    const r = validateView(spec);
    hasProblem(r, 'ui line 7 <Carousel of="places">', "11 items, max 8 — paginate or filter (limit=8, where=)");
  });

  it("Carousel limit= and where= bring the count back into range", () => {
    const spec = fixture("restaurants");
    spec.data.places.push(...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, type: "Place", name: `X${i}`, geo: [40.98, 29.02] })));
    spec.ui = spec.ui.replace('<Carousel of="places" skip="moda"', '<Carousel of="places" skip="moda" limit="8"');
    assert.equal(validateView(spec).ok, true);
    spec.ui = spec.ui.replace('limit="8"', 'where="rating>=4.5"');
    assert.equal(validateView(spec).ok, true);
  });

  it("Carousel below 3 items", () => {
    const r = validateView(withUi('<Carousel of="places" skip="moda lal ocak rihtim"/>'));
    hasProblem(r, 'ui line 1 <Carousel of="places">', "2 items, min 3 — show them in a Grid, List or Card instead");
  });

  it("more than one Map", () => {
    const r = validateView(withUi('<Map of="places"/>\n<Map of="places" route/>'));
    hasProblem(r, 'ui line 2 <Map of="places">', /^is map 2, max 1 per view/);
  });

  it("more than 40 images", () => {
    const spec = fixture("restaurants");
    spec.data.photos = Array.from({ length: 41 }, (_, i) => ({ id: `p${i}`, image: `https://img.example/${i}.jpg` }));
    hasProblem(validateView(spec), "data", "41 images, max 40 — keep the ones that matter");
  });

  it("more than two primary actions", () => {
    const spec = fixture("restaurants");
    spec.actions.route.primary = true;
    spec.actions.menu.primary = true;
    hasProblem(validateView(spec), "actions", "3 are primary (book, route, menu), max 2 — keep the main one or two");
  });

  it("summary required and ≤ 600", () => {
    const spec = fixture("restaurants");
    delete spec.summary;
    hasProblem(validateView(spec), "summary", /^is required/);
    spec.summary = "x".repeat(601);
    hasProblem(validateView(spec), "summary", "is 601 characters, max 600");
  });

  it("title required and ≤ 80", () => {
    const spec = fixture("restaurants");
    spec.title = "t".repeat(81);
    hasProblem(validateView(spec), "title", "is 81 characters, max 80");
    spec.title = "  ";
    hasProblem(validateView(spec), "title", /^is required/);
  });

  it("ui over 24 KB", () => {
    const text = `<Text>${"a".repeat(GENUI_LIMITS.uiBytes)}</Text>`;
    hasProblem(validateView(withUi(text)), "ui", /^is 24 KB, max 24 KB — move repeated content into data/);
  });

  it("data over 64 KB", () => {
    const spec = fixture("restaurants");
    spec.data.blob = "y".repeat(GENUI_LIMITS.dataBytes);
    hasProblem(validateView(spec), "data", /^is 6\d(\.\d)? KB, max 64 KB — trim fields or items$/);
  });

  it("nesting deeper than 8", () => {
    const open = Array.from({ length: 9 }, () => "<Stack>").join("");
    const close = Array.from({ length: 9 }, () => "</Stack>").join("");
    hasProblem(validateView(withUi(`${open}<Text>deep</Text>${close}`)), "ui line 1 <Stack>", "is nested 9 deep, max 8 — flatten the layout");
  });

  it("tone and icon outside the enums, replaces not a view id", () => {
    const spec = fixture("restaurants");
    spec.tone = "pink";
    spec.icon = "pizza";
    spec.replaces = "v_short";
    const r = validateView(spec);
    hasProblem(r, "tone", '"pink" is not one of blue, green, amber, red, violet, teal');
    hasProblem(r, "icon", /^"pizza" is not one of utensils, map, /);
    hasProblem(r, "replaces", /^"v_short" is not a view id/);
  });

  it("geo, price and entity type", () => {
    const spec = fixture("restaurants");
    spec.data.places[0].geo = [95, 29];
    spec.data.places[1].price = 5;
    spec.data.places[2].type = "Restaurant";
    spec.data.places[4].geo = [40.9];
    const r = validateView(spec);
    hasProblem(r, "data.places[0].geo[0]", "95 is not a latitude (−90–90)");
    hasProblem(r, "data.places[1].price", "5 is outside 1–4 (price level)");
    hasProblem(r, "data.places[2].type", /^"Restaurant" is not an entity type — use one of Place, Product, Event/);
    hasProblem(r, "data.places[4].geo", "must be [lat, lon] — two numbers");
  });

  it("typed entities need an id; ids are unique", () => {
    const spec = fixture("restaurants");
    delete spec.data.places[0].id;
    spec.data.places[2].id = "lal";
    const r = validateView(spec);
    hasProblem(r, "data.places[0].id", "is required");
    hasProblem(r, "data.places[2].id", '"lal" repeats an earlier id in places — ids must be unique');
  });

  it("source numbers point into data.sources (1-based)", () => {
    const spec = fixture("restaurants");
    spec.data.places[0].source = 5;
    hasProblem(validateView(spec), "data.places[0].source", "5 but data.sources has 4 — source is 1-based (1 = data.sources[0])");
    delete spec.data.sources;
    spec.ui = '<Card of="places" pick="moda"/>';
    hasProblem(validateView(spec), "data.places[0].source", /but data has no sources/);
  });

  it("a collection holds objects only", () => {
    const spec = fixture("restaurants");
    spec.data.places.push("Kadıköy");
    hasProblem(validateView(spec), "data.places[6]", '"Kadıköy" — a collection holds objects only');
  });

  it("reserved data names", () => {
    const spec = fixture("restaurants");
    spec.data.state = [{ id: "a" }];
    hasProblem(validateView(spec), "data.state", /is reserved by expressions/);
  });
});

describe("ui problems", () => {
  it("unknown component lists the valid names", () => {
    const r = validateView(withUi('<Card of="places" pick="moda"/>\n<Carousel2 of="places"/>'));
    const p = problemsOf(r).find((x) => x.path === 'ui line 2 <Carousel2 of="places">');
    assert.ok(p);
    assert.match(p.message, /^unknown component — use one of Section, Stack, Grid/);
    for (const n of COMPONENT_NAMES) assert.ok(p.message.includes(n));
  });

  it("an HTML tag gets the markdown hint", () => {
    hasProblem(validateView(withUi("<Text>hi <b>there</b></Text>")), "ui line 1 <b>", /^unknown component \(text is markdown — use \*\*bold\*\*, not HTML\)/);
  });

  it("attribute type errors name the attribute", () => {
    const r = validateView(withUi('<Grid cols="five"><Text>a</Text></Grid>\n<Grid cols={6}><Text>b</Text></Grid>\n<Stack gap="huge"/>'));
    hasProblem(r, "ui line 1 <Grid>.cols", '"five" is not a number');
    hasProblem(r, "ui line 2 <Grid>.cols", "6 is outside 1–4");
    hasProblem(r, "ui line 3 <Stack>.gap", '"huge" is not one of sm, md, lg');
  });

  it("required attributes", () => {
    const r = validateView(withUi("<Table of=\"places\"/>\n<Value/>"));
    hasProblem(r, 'ui line 1 <Table of="places">', "needs cols=");
    hasProblem(r, "ui line 2 <Value>", "needs expr=");
  });

  it("of= must name a data collection", () => {
    const r = validateView(withUi('<Table of="restaurants" cols="name"/>'));
    hasProblem(r, 'ui line 1 <Table of="restaurants">', 'data has no collection "restaurants" — collections: places, sources');
  });

  it("pick= must be an id of the collection", () => {
    const r = validateView(withUi('<Card of="places" pick="kiyi"/>'));
    hasProblem(r, 'ui line 1 <Card of="places" pick="kiyi">.pick', '"kiyi" is not an id in places — ids: moda, lal, ocak, rihtim, yel, sofra');
  });

  it("action references must exist", () => {
    const r = validateView(withUi('<Hero of="places" pick="moda" actions="book call">Why.</Hero>\n<Callout action="nope">x</Callout>'));
    hasProblem(r, 'ui line 1 <Hero of="places" pick="moda">.actions', 'action "call" is not defined — actions: book, route, menu, seaOnly, youBook, veg');
    hasProblem(r, "ui line 2 <Callout>.action", /^action "nope" is not defined/);
  });

  it("a Form submits a send action", () => {
    const r = validateView(withUi('<Form action="route"><Field bind="note"/></Form>'));
    hasProblem(r, "ui line 1 <Form>.action", '"route" is kind "open" — a Form submits a send action');
  });

  it("filters and expressions must parse", () => {
    const r = validateView(withUi('<List of="places" where="rating >> 4"/>\n<Value expr="sum(places.rating"/>\n<Filters of="places" chips="Cheap: price <"/>'));
    hasProblem(r, 'ui line 1 <List of="places">.where', /is not a valid filter/);
    hasProblem(r, 'ui line 2 <Value expr="sum(places.rating">.expr', /is not a valid expression/);
    hasProblem(r, 'ui line 3 <Filters of="places">.chips[0]', /^"Cheap": /);
  });

  it("markup errors carry the line", () => {
    const r = validateView(withUi('<Section title="a">\n  <Text>x</Text>\n'));
    hasProblem(r, "ui line 1", "<Section> opened on line 1 is never closed");
  });

  it("needs one of a group", () => {
    const r = validateView(withUi('<Chart type="bar"/>\n<Steps/>'));
    hasProblem(r, 'ui line 1 <Chart type="bar">', "needs of= or values=");
    hasProblem(r, "ui line 2 <Steps>", "needs of= or child elements");
  });

  it("action kinds need their fields", () => {
    const spec = fixture("restaurants");
    spec.actions.route = { label: "Yol", kind: "open" };
    spec.actions.copyIt = { label: "Copy", kind: "copy" };
    spec.actions.pick = { label: "Pick", kind: "set" };
    spec.actions.bad = { label: "Bad", kind: "open", href: "javascript:alert(1)" };
    const r = validateView(spec);
    hasProblem(r, "actions.route.href", /^is required for kind "open"/);
    hasProblem(r, "actions.copyIt.text", 'is required for kind "copy"');
    hasProblem(r, "actions.pick.set", /^is required for kind "set"/);
    hasProblem(r, "actions.bad.href", /^"javascript:alert\(1\)" must be an http\(s\) URL/);
  });

  it("formats problems for the tool result", () => {
    const text = formatProblems([
      { path: "data.places[3].rating", message: "6.2 is outside 0–5" },
      { path: 'ui line 4 <Carousel of="places">', message: "11 items, max 8 — paginate or filter" },
    ]);
    assert.equal(
      text,
      '2 problems — nothing rendered\n· data.places[3].rating: 6.2 is outside 0–5\n· ui line 4 <Carousel of="places">: 11 items, max 8 — paginate or filter\nfix and call present again',
    );
  });

  it("never throws on garbage", () => {
    for (const input of [null, 42, "present", [], { ui: 5 }, { title: {}, ui: "<<<>>>", summary: [] }, { title: "t", summary: "s", ui: "<Card of={{{" }]) {
      const r = validateView(input);
      assert.equal(r.ok, false);
    }
  });
});

describe("warnings", () => {
  it("are returned on success", () => {
    const r = validateView(
      withUi('<Card of="places" pick="moda" sparkle/>\n<Table of="places" cols="name stars"/>\n<Value expr="party * 2"/>', { extra: 1 }),
    );
    assert.ok(r.ok);
    const lines = r.warnings.map((w) => `${w.path}: ${w.message}`);
    assert.ok(lines.includes("extra: is not a present field — ignored (fields: title, tone, icon, replaces, data, actions, ui, summary)"));
    assert.ok(lines.includes('ui line 1 <Card of="places" pick="moda">.sparkle: is not an attribute of <Card> — ignored'));
    assert.ok(lines.includes('ui line 2 <Table of="places">.cols: "stars" is not a field of any places item — the column stays empty'));
    assert.ok(lines.includes('ui line 3 <Value expr="party * 2">.expr: "party" is not a state key (bind=) or data key — it reads as empty'));
  });

  it("a bound key is known to expressions and action text", () => {
    const spec = withUi('<Stepper bind="party" min="1" max="12" default="2"/>\n<Value expr="party * 2"/>');
    (spec.actions as Record<string, { text?: string }>).book.text = "Book {name} for {state.party}";
    const r = validateView(spec);
    assert.ok(r.ok);
    assert.deepEqual(r.warnings, []);
  });

  it("action text reading an unbound state key", () => {
    const spec = withUi('<Card of="places" pick="moda" actions="book"/>');
    (spec.actions as Record<string, { text?: string }>).book.text = "Book for {state.party}";
    const r = validateView(spec);
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => w.path === "actions.book.text" && /state\.party/.test(w.message)));
  });

  it("a default outside the options", () => {
    const r = validateView(withUi('<Segmented bind="day" options="Cumartesi | Pazar" default="Cuma"/>'));
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => w.path === 'ui line 1 <Segmented bind="day">.default'));
  });

  it("items without geo get no pin", () => {
    const spec = fixture("restaurants");
    delete spec.data.places[0].geo;
    const r = validateView(spec);
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => w.message === "1 of 6 places have no geo or address — they get no pin"));
  });
});

describe("COMPONENT_SCHEMAS", () => {
  it("has one schema per component", () => {
    assert.deepEqual(Object.keys(COMPONENT_SCHEMAS), COMPONENT_NAMES);
  });

  it("coerces markup strings and accepts templates", () => {
    assert.equal(COMPONENT_SCHEMAS.Grid.safeParse({ cols: "3" }).success, true);
    assert.equal(COMPONENT_SCHEMAS.Grid.safeParse({ cols: "9" }).success, false);
    assert.equal(COMPONENT_SCHEMAS.Rating.safeParse({ value: "{rating}" }).success, true);
    assert.equal(COMPONENT_SCHEMAS.Rating.safeParse({ value: 7 }).success, false);
    assert.equal(COMPONENT_SCHEMAS.Rating.safeParse({}).success, false);
    assert.equal(COMPONENT_SCHEMAS.Map.safeParse({ of: "places", you: true, route: "true" }).success, true);
    assert.equal(COMPONENT_SCHEMAS.Map.safeParse({ of: "places", you: [40.98, 29.02] }).success, true);
    assert.equal(COMPONENT_SCHEMAS.Value.safeParse({ expr: "fv(save, 0.2, years)" }).success, true);
    assert.equal(COMPONENT_SCHEMAS.Value.safeParse({ expr: "alert(1)" }).success, false);
  });
});
