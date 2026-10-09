import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { catalogPrompt } from "../genui/prompt.ts";
import { COMPONENT_NAMES, GENUI_ICONS, GENUI_TONES } from "../genui/catalog.ts";

// Regenerate after an intended catalog change: UPDATE_SNAPSHOTS=1 npm test
const SNAPSHOT = new URL("./fixtures/genui/catalog-prompt.snap.md", import.meta.url);

describe("catalogPrompt", () => {
  it("matches the snapshot", () => {
    const text = catalogPrompt();
    if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(SNAPSHOT)) writeFileSync(SNAPSHOT, `${text}\n`);
    assert.equal(`${text}\n`, readFileSync(SNAPSHOT, "utf8"));
  });

  it("is deterministic", () => {
    assert.equal(catalogPrompt(), catalogPrompt());
  });

  it("documents every component, tone and icon", () => {
    const text = catalogPrompt();
    for (const name of COMPONENT_NAMES) assert.match(text, new RegExp(`^- ${name}\\b`, "m"), name);
    for (const tone of GENUI_TONES) assert.ok(text.includes(tone), tone);
    for (const icon of GENUI_ICONS) assert.ok(text.includes(icon), icon);
    assert.ok(text.includes("title, tone, icon, replaces, data, actions, ui, summary"));
  });

  it("stays compact (≈1.2–1.8k tokens)", () => {
    const text = catalogPrompt();
    const roughTokens = (text.match(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g) ?? []).length;
    assert.ok(roughTokens >= 1200 && roughTokens <= 1850, `≈${roughTokens} tokens`);
  });
});
