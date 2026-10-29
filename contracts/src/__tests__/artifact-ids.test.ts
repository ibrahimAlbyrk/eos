import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { artifactSlugFromUrl, artifactViewerUrl, shortIdOf, slugOfShortId } from "../artifact-ids.ts";

// A real pair: the boot response's viewerPath for this uuid.
const SLUG = "53b36e79-b067-412a-962e-60219d0e7186";
const SHORT = "BLUSnX4ryWVrJkeDQtv9mP";

describe("artifact ids", () => {
  it("encodes a uuid as its 22-character base58 short id and back", () => {
    assert.equal(shortIdOf(SLUG), SHORT);
    assert.equal(slugOfShortId(SHORT), SLUG);
  });

  it("keeps leading zero bits at full length", () => {
    const zero = "00000000-0000-0000-0000-000000000001";
    const short = shortIdOf(zero);
    assert.equal(short?.length, 22);
    assert.equal(slugOfShortId(short!), zero);
  });

  it("rejects malformed ids", () => {
    assert.equal(shortIdOf("not-a-uuid"), null);
    assert.equal(slugOfShortId("short"), null);
    assert.equal(slugOfShortId("0OIl0OIl0OIl0OIl0OIl0O"), null); // outside the alphabet
    assert.equal(slugOfShortId("zzzzzzzzzzzzzzzzzzzzzz"), null); // over 128 bits
  });

  it("reads the uuid from either URL form", () => {
    assert.equal(artifactSlugFromUrl(`https://claude.ai/artifact/${SHORT}`), SLUG);
    assert.equal(artifactSlugFromUrl(`https://claude.ai/code/artifact/${SLUG}`), SLUG);
    assert.equal(artifactSlugFromUrl(`https://claude.ai/code/artifact/${SLUG.toUpperCase()}?x=1`), SLUG);
    assert.equal(artifactSlugFromUrl(`https://preview.claude.ai/artifact/${SHORT}#top`), SLUG);
    assert.equal(artifactSlugFromUrl("https://claude.ai/chat/abc"), null);
    assert.equal(artifactSlugFromUrl("https://example.com/artifact/BLUSnX4ryWVrJkeDQtv9mP"), null);
  });

  it("builds the viewer URL from the short id", () => {
    assert.equal(artifactViewerUrl(SLUG), `https://claude.ai/artifact/${SHORT}`);
  });
});
