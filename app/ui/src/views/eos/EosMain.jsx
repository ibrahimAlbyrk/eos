import { NewRoutine } from "./blueprint/NewRoutine.jsx";
import { HomeScreen } from "./home/HomeScreen.jsx";
import { FormArrival } from "./input/FormArrival.jsx";
import { CapabilitiesScreen } from "./capabilities/CapabilitiesScreen.jsx";
import { CapabilityScreen } from "./capabilities/CapabilityScreen.jsx";
import { EosMemoryScreen } from "./memory/EosMemoryScreen.jsx";
import { EosHeader } from "./nav/EosHeader.jsx";
import { NeedsItemScreen } from "./needs/NeedsItemScreen.jsx";
import { NeedsYouList } from "./needs/NeedsYouList.jsx";
import { RoutinePage } from "./routine/RoutinePage.jsx";
import { RoutinesScreen } from "./routines/RoutinesScreen.jsx";
import { RunView } from "./run/RunView.jsx";
import { SurfaceScreen } from "./surface/SurfaceScreen.jsx";
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
    <main className="eos-screen eos-screen--read">
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
  if (location?.screen === "home") return <HomeScreen />;
  if (location?.screen === "form") return <><HomeScreen /><FormArrival key={JSON.stringify(location)} location={location} /></>;
  if (location?.screen === "needs") return <NeedsYouList />;
  if (location?.screen === "need") return <NeedsItemScreen key={location.itemId} id={location.itemId} />;
  if (location?.screen === "routines") return <RoutinesScreen />;
  if (location?.screen === "new-routine") return <NewRoutine />;
  if (location?.screen === "routine") return <RoutinePage key={location.routineId} id={location.routineId} tab={location.tab} />;
  if (location?.screen === "version") return <RoutinePage key={location.routineId} id={location.routineId} tab="blueprint" version={location.version} />;
  if (location?.screen === "run") return <RunView key={location.runId} id={location.runId} />;
  if (location?.screen === "memory") return <EosMemoryScreen tab={location.tab} note={location.note} />;
  if (location?.screen === "capabilities") return <CapabilitiesScreen />;
  if (location?.screen === "capability") return <CapabilityScreen key={location.capabilityId} id={location.capabilityId} />;
  if (location?.screen === "surface") return (
      <SurfaceScreen
        key={location.surfaceId}
        surfaceId={location.surfaceId}
        seq={location.issue}
        mode={location.mode}
        linked={location.button ? { button: location.button, index: location.index } : undefined}
      />
    );
  return <PlaceholderScreen location={location} />;
}
