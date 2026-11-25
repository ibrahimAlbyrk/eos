import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Band, EmptyState, Section } from "./frame.jsx";

describe("Eos's shared screen parts", () => {
  it("a section is labelled by its heading, with its aside at the right", () => {
    const html = renderToStaticMarkup(<Section id="s" label="Recent runs" aside="12">rows</Section>);
    expect(html).toBe('<section class="eos-section" aria-labelledby="s"><div class="eos-section__head"><h2 id="s" class="eos-label">Recent runs</h2><span class="eos-section__aside">12</span></div>rows</section>');
  });

  it("an empty state says what the place is for and offers one step", () => {
    const html = renderToStaticMarkup(<EmptyState title="No routines yet" action={<button type="button">New routine</button>}>Say what Eos should take care of.</EmptyState>);
    expect(html).toBe('<div class="eos-empty"><p class="eos-empty__title">No routines yet</p><p class="eos-empty__text">Say what Eos should take care of.</p><div class="eos-actions"><button type="button">New routine</button></div></div>');
  });

  it("a band carries its tone in its class and its role for screen readers", () => {
    expect(renderToStaticMarkup(<Band tone="err" role="alert">Could not save.</Band>)).toBe('<div class="eos-band eos-band--err" role="alert"><span class="eos-band__text">Could not save.</span></div>');
  });
});
