// present_app's check, view ids from a byte stream, and the tool result texts.

const HTML = "<!doctype html><html><head><title>t</title></head><body><script>let a = 1;</script></body></html>";

export default function ({ call, mods }) {
  const app = (input) => call("app", "validateApp", input);
  const ok = { title: "App", summary: "Does a thing.", html: HTML };
  app(ok);
  for (const input of [null, undefined, 5, "x", [], [ok], {}]) if (input !== undefined) app(input);
  const values = [null, true, 5, 199, 200, 200.5, 720, 721, -1, 1e9, "", " ", "x", "300", [], {}, "x".repeat(80), "x".repeat(81), "x".repeat(600), "x".repeat(601), "😀".repeat(41), HTML];
  for (const key of ["title", "summary", "html", "height", "extra", "ui", "constructor"]) {
    for (const v of values) app({ ...ok, [key]: v });
    const { [key]: _dropped, ...rest } = ok;
    app(rest);
  }
  for (const html of [
    "plain text", "<p>hi</p>", "<P>HI</P>", "<!doctype html>", "< p>", "<1>", "a < b > c", "<>", "<html><html>", "<html></html><HTML >", "<html\n><html>", "<htmlx><html>", "<html><html><html lang='en'>",
    '<script src="x.js"></script>', "<script\nsrc = 'x.js'>", "<script data-src='x'>", "<script>var src = 1</script>", "<script async xsrc='x'>", '<script a="1" src=x>', "<SCRIPT SRC=x>", "<script>src=1",
    '<link href="https://cdn.example/x.css">', "<link rel=x href=http://a>", "<link href='/local.css'>", '<link rel="x" HREF = "HTTPS://A">', "<link href=ftp://a>", "<link data-href='https://a'>", "<link href = '  https://a'>",
    `<p>${"é".repeat(128 * 1024)}</p>`, `<p>${"a".repeat(256 * 1024 - 7)}</p>`, `<p>${"a".repeat(256 * 1024 - 6)}</p>`, `<p>${"a".repeat(256 * 1024 + 505)}</p>`, `<p>${"a".repeat(256 * 1024 + 506)}</p>`, `<p>${"a".repeat(300 * 1024)}</p>`, "a".repeat(300 * 1024),
  ]) app({ ...ok, html });

  const stats = { uiBytes: 10, dataBytes: 20, elements: 1, depth: 1, components: ["Card"], collections: [], images: 0, sites: 0, maps: 0, primaryActions: 0 };
  const collections = [[], [{ name: "places", count: 6, type: "Place" }], [{ name: "sources", count: 9, type: null }, { name: "a", count: 2, type: null }, { name: "b", count: 2, type: "File" }], [{ name: "a", count: 1, type: null }, { name: "b", count: 3, type: null }, { name: "c", count: 3, type: null }], [{ name: "sources", count: 1, type: null }]];
  const problems = [{ path: "data.places[3].rating", message: "6.2 is outside 0–5" }, { path: 'ui line 4 <Carousel of="places">', message: "11 items, max 8 — paginate or filter" }];
  for (const list of collections) {
    const s = { ...stats, collections: list };
    call("app", "statsLine", s);
    for (const opts of [undefined, {}, { unresolvedImages: 0 }, { unresolvedImages: 1 }, { unresolvedImages: 2, warnings: [] }, { warnings: problems }, { unresolvedImages: 3, warnings: problems.slice(0, 1) }]) {
      if (opts === undefined) call("app", "presentSuccessText", "v_7Hq2abcdEFGH", s);
      else call("app", "presentSuccessText", "v_7Hq2abcdEFGH", s, opts);
    }
  }
  call("app", "appSuccessText", "v_7Hq2abcdEFGH");
  for (const list of [[], problems.slice(0, 1), problems]) {
    call("app", "formatProblems", list);
    call("app", "genuiRejection", list);
  }
  for (const name of [...mods.catalog.COMPONENT_NAMES, "card", "Card ", "", "constructor", "toString", "__proto__", "Unknown"]) call("app", "isComponentName", name);

  // newViewId over a fixed byte stream: bytes ≥ 248 are rejected, the rest map to base62.
  const streams = [Array(16).fill(0), Array.from({ length: 16 }, (_, i) => i * 16 + 7), Array.from({ length: 64 }, (_, i) => (i * 37 + 250) % 256), [...Array(16).fill(255), ...Array(16).fill(248), ...Array.from({ length: 16 }, (_, i) => 247 - i)], Array.from({ length: 32 }, (_, i) => (i % 2 ? 61 : 252))];
  for (const bytes of streams) {
    let at = 0;
    const id = mods.spec.newViewId((b) => {
      for (let i = 0; i < b.length; i++) b[i] = bytes[(at++) % bytes.length];
      return b;
    });
    call("app", "viewIdFromBytes", bytes, id);
  }
}
