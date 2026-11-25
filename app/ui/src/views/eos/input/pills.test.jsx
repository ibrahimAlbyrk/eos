import { describe, it, expect, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { ROUTES } from "../../../api/routes.js";
import { makeRoutine } from "../../../state/eos/blueprintStore.js";
import { startOnce } from "../../../state/eos/runsStore.js";
import { HomePills } from "./HomePills.jsx";
import { choiceFields, homeModels, modelLabel, NO_CHOICES, projectLabel, rungLabel } from "./homePills.js";

afterEach(() => setEosTransport(null));

describe("the Home input's pills", () => {
  it("say the rung, the project and the model in words, as designed", () => {
    expect(rungLabel("make", "draft")).toBe("Ask before sending");
    expect(rungLabel("make", "ask")).toBe("Ask before each run");
    expect(rungLabel("once", "ask")).toBe("Ask before sending");
    const projects = [{ id: "p1", name: "game", folders: ["/Users/me/game"] }];
    expect(projectLabel(projects, null)).toBe("Any project");
    expect(projectLabel(projects, "/Users/me/game")).toBe("game");
    expect(modelLabel("make", "opus")).toBe("Opus 5.5 · High");
    expect(modelLabel("once", null)).toBe("Default model");
    expect(homeModels().map((m) => m.value)).toEqual(["haiku", "sonnet", "opus"]);
  });

  it("never offer more than Draft, and send only what the user changed", () => {
    expect(choiceFields("make", NO_CHOICES)).toEqual({});
    const chosen = { rung: "ask", project: "/Users/me/game", model: "opus" };
    expect(choiceFields("make", chosen)).toEqual(chosen);
    expect(choiceFields("once", chosen)).toEqual({ project: "/Users/me/game", model: "opus" });
    expect(choiceFields("make", { ...NO_CHOICES, rung: "on_its_own" })).toEqual({ rung: "on_its_own" });
  });

  it("draw the shield and folder pills, and a one-off's freedom pill fixed", () => {
    const make = renderToStaticMarkup(<HomePills intent="make" choices={NO_CHOICES} setChoices={() => {}} />);
    expect(make).toContain("Ask before sending");
    expect(make).toContain("Any project");
    expect(make).toContain("Default model · High");
    expect(make).not.toContain("disabled");
    const once = renderToStaticMarkup(<HomePills intent="once" choices={{ ...NO_CHOICES, rung: "ask" }} setChoices={() => {}} />);
    expect(once).toContain("disabled");
    expect(once).toContain("Ask before sending");
  });

  it("carry the choices into the architect's and the one-off's requests", async () => {
    const sent = [];
    setEosTransport({ ...fixtureTransport({}), send: async (method, path, body) => (sent.push([path, body]), { ok: false, status: 400, body: {} }) });
    await makeRoutine("Review my pull requests", { rung: "ask", model: "opus" });
    await startOnce({ text: "x", attachments: [], result: "usual", door: "home", project: "/Users/me/game" });
    expect(sent.find(([path]) => path === ROUTES.routinesArchitect)?.[1]).toEqual({ sentence: "Review my pull requests", rung: "ask", model: "opus" });
    expect(sent.find(([path]) => path === ROUTES.runsOnce)?.[1]).toMatchObject({ project: "/Users/me/game" });
  });
});
