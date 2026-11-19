import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EosMain } from "./EosMain.jsx";
import { EosHeader } from "./nav/EosHeader.jsx";
import { openLocation, _resetEosNav } from "./nav/eosNav.js";

beforeEach(() => _resetEosNav());

describe("an Eos screen's header", () => {
  it("is a breadcrumb whose last part is the h1", () => {
    const html = renderToStaticMarkup(
      <EosHeader trail={[{ label: "Eos", location: "eos:/" }, { label: "PR Review", location: "eos:/routines/rt-1" }, { label: "Run on #470" }]} />,
    );
    expect(html).toBe(
      '<header class="pane-head pane-head--topleft eos-head"><span class="pane-head-inset" aria-hidden="true"></span>'
      + '<nav class="eos-crumbs" aria-label="Breadcrumb">'
      + '<button type="button" class="eos-crumb">Eos</button><span class="eos-crumb-sep" aria-hidden="true">/</span>'
      + '<button type="button" class="eos-crumb">PR Review</button><span class="eos-crumb-sep" aria-hidden="true">/</span>'
      + '</nav><h1 class="eos-title">Run on #470</h1></header>',
    );
  });

  it("is the h1 alone at the top", () => {
    expect(renderToStaticMarkup(<EosHeader trail={[{ label: "Home" }]} />)).toBe(
      '<header class="pane-head pane-head--topleft eos-head"><span class="pane-head-inset" aria-hidden="true"></span>'
      + '<h1 class="eos-title">Home</h1></header>',
    );
  });
});

describe("Eos's main column", () => {
  it("lands a location without a screen yet on a plain page in Eos", () => {
    openLocation("eos:/memory");
    const html = renderToStaticMarkup(<EosMain />);
    expect(html).toContain('<main class="eos-screen">');
    expect(html).toContain('<h1 class="eos-title">Memory</h1>');
    expect(html).toContain("This part of Eos is not here yet.");
  });

  it("lands a string that is no Eos location there too", () => {
    openLocation("eos:/somewhere-newer/x");
    const html = renderToStaticMarkup(<EosMain />);
    expect(html).toContain('<h1 class="eos-title">Not found</h1>');
    expect(html).toContain("Eos has no page at this address.");
  });
});
