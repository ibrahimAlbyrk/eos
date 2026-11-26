import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AskRows, Band, Dialog, EmptyState, FailedLead, Section, askKey } from "./frame.jsx";

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

  it("a failed read leads with what could not be read, then Try again and the quiet way back", () => {
    const html = renderToStaticMarkup(<FailedLead what="this run" retry={() => {}} back={{ label: "Back to Routines", location: "eos:/routines" }} />);
    expect(html).toContain('<p class="eos-lead eos-failed__what">Couldn&#x27;t load this run.</p><p class="eos-rlead__now">Eos did not answer this time.</p>');
    expect(html).toMatch(/eos-btn--primary">Try again<\/button><button type="button" class="eos-btn eos-btn--quiet">Back to Routines<\/button>/);
  });

  it("a dialog names where it comes from, asks its question, and puts Cancel before the act", () => {
    const html = renderToStaticMarkup(
      <Dialog id="d" from="A routine file" title="Make a draft of PR Review?" line="Nothing runs yet." onClose={() => {}} actions={<><button type="button">Cancel</button><button type="button">Make the draft</button></>}>
        <AskRows rows={[["File", "pr.json"]]} />
      </Dialog>,
    );
    expect(html).toContain('<div class="eos-ask" role="dialog" aria-modal="true" aria-labelledby="d-title">');
    expect(html).toContain('<p class="eos-ask__from">A routine file</p><h2 id="d-title" class="eos-ask__title">Make a draft of PR Review?</h2><p class="eos-ask__line">Nothing runs yet.</p>');
    expect(html).toContain('<dl class="eos-ask__rows"><div><dt>File</dt><dd>pr.json</dd></div></dl>');
    expect(html.indexOf(">Cancel<")).toBeLessThan(html.indexOf(">Make the draft<"));
  });

  it("a dialog closes on Escape and keeps Tab inside, wrapping at either edge", () => {
    const [cancel, act] = [{ name: "Cancel" }, { name: "Remove" }];
    const all = [cancel, act];
    expect(askKey("Escape", false, [], cancel)).toBe("close");
    expect(askKey("Tab", false, all, act)).toBe(cancel);
    expect(askKey("Tab", true, all, cancel)).toBe(act);
    expect(askKey("Tab", false, all, cancel)).toBeNull();
    expect(askKey("Tab", true, all, act)).toBeNull();
    expect(askKey("Tab", false, [], null)).toBeNull();
    expect(askKey("Enter", false, all, act)).toBeNull();
  });
});
