import { EosHeader } from "./nav/EosHeader.jsx";
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
      <p className="eos-note">{location ? "This part of Eos is not here yet." : "Eos has no page at this address."}</p>
    </main>
  );
}

// Eos mode's main column: the screen of the current location. It reads only
// Eos's own stores, never the app's providers, so the sample gallery draws it
// as the app does.
export function EosMain() {
  return <PlaceholderScreen location={parseLocation(useEosLocation())} />;
}
