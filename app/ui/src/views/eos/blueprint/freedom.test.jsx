import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { _resetFreedom, loadFreedom } from "../../../state/eos/freedomStore.js";
import { applyEosEvent } from "../../../state/eos/live.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { FreedomLadder, streakLine } from "./FreedomLadder.jsx";

const ID = "rt-pr";
const view = (patch) => ({ routineId: ID, rung: "draft", grants: [], streak: 0, offer: "none", ...patch });
const BLUEPRINT = { name: "PR Review", freedom: { rung: "draft" }, goesTo: [] };

describe("the Freedom row's streak line", () => {
  beforeEach(() => _resetFreedom());

  it("says how near the next offer is, and nothing at the top rung", () => {
    expect(streakLine(view({}))).toBe("Eos will offer the next step once ten in a row go out unedited.");
    expect(streakLine(view({ streak: 4 }))).toBe("4 of 10 in a row went out unedited. Eos will offer the next step at 10.");
    expect(streakLine(view({ streak: 10, offer: "offered" }))).toBe("Eos offers the next step in Needs you.");
    expect(streakLine(view({ offer: "never" }))).toBe("Eos will not offer this routine more freedom.");
    expect(streakLine(view({ rung: "on_its_own", streak: 3 }))).toBeNull();
    expect(streakLine(undefined)).toBeNull();
  });

  it("reads the routine's confirmed Freedom and reads it again on inbox:freedom", async () => {
    const reads = { [ROUTES.routineFreedom(ID)]: view({ streak: 2 }) };
    setEosTransport(fixtureTransport(reads));
    await loadFreedom(ID);
    const html = renderToStaticMarkup(<FreedomLadder blueprint={BLUEPRINT} routineId={ID} />);
    expect(html).toContain('<p class="eos-bp-row__note">2 of 10 in a row went out unedited.');

    reads[ROUTES.routineFreedom(ID)] = view({ streak: 3 });
    applyEosEvent("inbox:freedom", { routineId: ID, rung: "draft", streak: 3, offer: "none" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderToStaticMarkup(<FreedomLadder blueprint={BLUEPRINT} routineId={ID} />)).toContain("3 of 10 in a row");
  });

  it("shows no line for a routine nothing was confirmed of, nor without a routine", async () => {
    setEosTransport(fixtureTransport({}));
    await loadFreedom(ID);
    expect(renderToStaticMarkup(<FreedomLadder blueprint={BLUEPRINT} routineId={ID} />)).not.toContain("eos-bp-row__note");
    expect(renderToStaticMarkup(<FreedomLadder blueprint={BLUEPRINT} />)).not.toContain("eos-bp-row__note");
  });
});
