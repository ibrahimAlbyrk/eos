import { describe, it, expect, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../../state/eos/transport.js";
import { SlackRecipientDialog, slackChoices } from "./editors.jsx";

const conversations = [
  { key: "C0GENERAL1", kind: "slack.conversation", title: "#general", updatedAt: 0, data: { kind: "channel" } },
  { key: "C0RANDOM01", kind: "slack.conversation", title: "#random", updatedAt: 0, data: { kind: "channel" } },
];
const people = [{ key: "U0BOB0001", kind: "slack.person", title: "Bob Builder", updatedAt: 0, data: { name: "bob" } }];

afterEach(() => setEosTransport(null));

describe("the Slack picker in Goes to", () => {
  it("offers the channels and people Slack lists, narrowed by what is typed", async () => {
    const all = (item, q) => `${ROUTES.capabilityCandidates}?${new URLSearchParams({ item, limit: "20", ...(q ? { q } : {}) })}`;
    setEosTransport(fixtureTransport({
      [all("slack.conversation")]: conversations, [all("slack.person")]: people,
      [all("slack.conversation", "gen")]: conversations, [all("slack.person", "gen")]: [],
    }));
    expect((await slackChoices("")).map((c) => c.title)).toEqual(["#general", "#random", "Bob Builder"]);
    expect((await slackChoices("gen")).map((c) => c.key)).toEqual(["C0GENERAL1"]);
  });

  it("asks Slack before it lists anything and never takes a typed name as a recipient", () => {
    const html = renderToStaticMarkup(<SlackRecipientDialog done={() => {}} />);
    expect(html).toContain("Add a Slack channel or person");
    expect(html).toContain('<p class="eos-note" role="status">Asking Slack…</p>');
    expect(html).not.toContain(">Add<");
  });
});
