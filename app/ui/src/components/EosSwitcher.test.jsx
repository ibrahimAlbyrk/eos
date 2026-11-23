import { describe, it, expect, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../api/routes.js";
import { fixtureTransport, setEosTransport } from "../state/eos/transport.js";
import { probeEosStatus } from "../state/eos/eosStatusStore.js";
import { visibleTabs } from "../views/tabs.js";
import { SwitcherMenu } from "./EosSwitcher.jsx";

async function eosServed(served) {
  setEosTransport(fixtureTransport(served ? { [ROUTES.routines]: [] } : {}));
  await probeEosStatus();
}

// Each row as "<label> <what sits at its end>".
function rows(activeViewId, withKeys) {
  const html = renderToStaticMarkup(
    <SwitcherMenu tabs={visibleTabs()} activeViewId={activeViewId} onPick={() => {}} withKeys={withKeys} />,
  );
  return [...html.matchAll(/<span>([^<]+)<\/span><span class="eos-menu__(kbd|check)( on)?">([^<]*)/g)]
    .map(([, label, end, on, text]) => `${label} ${end === "kbd" ? text : on ? "✓" : "-"}`);
}

afterEach(() => setEosTransport(null));

describe("the mode switcher", () => {
  it("names each mode's shortcut while Eos shows; the open mode wears the check", async () => {
    await eosServed(true);
    expect(rows("eos", true)).toEqual(["Eos ✓", "Agents ⌘⌃2", "Code ⌘⌃3", "Machines ⌘⌃4"]);
    expect(rows("code", true)).toEqual(["Eos ⌘⌃1", "Agents ⌘⌃2", "Code ✓", "Machines ⌘⌃4"]);
  });

  it("is today's menu while Eos is hidden", async () => {
    await eosServed(false);
    expect(rows("agents", false)).toEqual(["Agents ✓", "Code -", "Machines -"]);
  });
});
