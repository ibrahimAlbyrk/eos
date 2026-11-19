import { CapabilitiesScreen } from "./capabilities/CapabilitiesScreen.jsx";
import { CapabilityScreen } from "./capabilities/CapabilityScreen.jsx";
import { EosHeader } from "./nav/EosHeader.jsx";
import { NeedsItemScreen } from "./needs/NeedsItemScreen.jsx";
import { NeedsYouList } from "./needs/NeedsYouList.jsx";
import { RoutinePage } from "./routine/RoutinePage.jsx";
import { RunView } from "./run/RunView.jsx";
import { parseLocation, useEosLocation } from "./nav/eosNav.js";

const SECTION_TITLES = {
  home: "Home",
  needs: "Needs you",
  need: "Needs you",
  routines: "Routines",
  "new-routine": "New routine",
  routine: "Routines",
  version: "Routines",
  run: "Runs",
  memory: "Memory",
  capabilities: "Capabilities",
  capability: "Capabilities",
  surface: "Pages",
  form: "Run a routine",
};

// Where a location lands that has no screen in this version, or that is no
// Eos location at all (a route from a newer app): a plain page, never a crash.
function PlaceholderScreen({ location }) {
  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Eos", location: "eos:/" }, { label: location ? SECTION_TITLES[location.screen] : "Not found" }]} />
      <div className="eos-body">
        <p className="eos-note">{location ? "This part of Eos is not here yet." : "Eos has no page at this address."}</p>
      </div>
    </main>
  );
}

// Eos mode's main column: the screen of the current location. It reads only
// Eos's own stores, never the app's providers, so the sample gallery draws it
// as the app does.
export function EosMain() {
  const location = parseLocation(useEosLocation());
  // Until Home arrives (P5), Eos's start shows what needs the user.
  if (location?.screen === "home" || location?.screen === "needs") return <NeedsYouList />;
  if (location?.screen === "need") return <NeedsItemScreen key={location.itemId} id={location.itemId} />;
  if (location?.screen === "routine") return <RoutinePage key={location.routineId} id={location.routineId} tab={location.tab} />;
  if (location?.screen === "run") return <RunView key={location.runId} id={location.runId} />;
  if (location?.screen === "capabilities") return <CapabilitiesScreen />;
  if (location?.screen === "capability") return <CapabilityScreen key={location.capabilityId} id={location.capabilityId} />;
  return <PlaceholderScreen location={location} />;
}
