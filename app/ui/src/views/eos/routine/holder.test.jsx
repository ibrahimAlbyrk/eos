import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetRunners, loadRunners, moveHere } from "../../../state/eos/runnersStore.js";
import { HolderLine, sinceWord } from "./Holder.jsx";
import { MoveDialog } from "./MoveDialog.jsx";

const DAY = 24 * 60 * 60 * 1000;
const routine = { id: "rt-1", name: "PR Review" };
const air = (awaySince) => ({ deviceId: "air", name: "MacBook Air", seenAt: 1, awaySince, routines: ["rt-1"] });
const view = (devices) => ({ [ROUTES.runners]: { deviceId: "pro", devices, confirmedAt: 5 } });

beforeEach(() => _resetRunners());
afterEach(() => setEosTransport(null));

describe("which Mac runs a routine", () => {
  it("says nothing while this Mac runs it", async () => {
    setEosTransport(fixtureTransport(view([{ ...air(undefined), routines: ["rt-other"] }])));
    await loadRunners();
    expect(renderToStaticMarkup(<HolderLine routine={routine} />)).toBe("");
  });

  it("names the Mac that runs it, and once it is away, since when, with Move here", async () => {
    setEosTransport(fixtureTransport(view([air(undefined)])));
    await loadRunners();
    let html = renderToStaticMarkup(<HolderLine routine={routine} />);
    expect(html).toContain("Runs on MacBook Air<");
    expect(html).not.toContain("Move here");

    const tuesday = Date.parse("2026-11-24T09:00:00Z");
    setEosTransport(fixtureTransport(view([air(tuesday)])));
    await loadRunners();
    html = renderToStaticMarkup(<HolderLine routine={routine} />);
    expect(html).toContain(`Runs on MacBook Air, away since ${sinceWord(tuesday)}`);
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Move here</button>');
  });

  it("names the day within a week and the date before", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    expect(sinceWord(Date.parse("2026-11-24T12:00:00Z"), now)).toBe("Tuesday");
    expect(sinceWord(now - 9 * DAY, now)).toBe("November 17");
  });

  it("warns what may happen twice before the move", () => {
    const html = renderToStaticMarkup(<MoveDialog routine={routine} holder={air(Date.now() - DAY)} onClose={() => {}} />);
    expect(html).toContain("Move PR Review to this Mac?");
    expect(html).toContain("may be done again, such as a review posted or a mail sent twice");
    expect(html).toContain(">Move here</button>");
  });

  it("claims the routine, and says why when this Mac cannot take it or another took it first", async () => {
    const sent = [];
    const answers = [
      { ok: false, status: 409, body: { error: "Connect github on this Mac first" } },
      { ok: true, status: 200, body: { routineId: "rt-1", claimed: false, holder: "mini", epoch: 3 } },
      { ok: true, status: 200, body: { routineId: "rt-1", claimed: true, holder: "pro", epoch: 3 } },
    ];
    setEosTransport({ ...fixtureTransport(view([])), send: async (...args) => { sent.push(args); return answers.shift(); } });
    expect(await moveHere("rt-1")).toEqual({ error: "Connect github on this Mac first" });
    expect(await moveHere("rt-1")).toEqual({ holder: "mini" });
    expect(await moveHere("rt-1")).toEqual({ moved: true });
    expect(sent[0]).toEqual(["POST", ROUTES.runnersClaim, { routineId: "rt-1" }]);
  });
});
