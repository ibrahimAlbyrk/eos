import { useEffect } from "react";
import { ensureCapabilitiesLoaded, refreshCapabilities, useCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { CapabilityState, DevRunNote, FixButton, LoadFailed, Loading } from "./parts.jsx";
import { SignInSheet } from "./SignInSheet.jsx";
import { fixFor, ORIGINS, usedBy } from "./words.js";

function CapabilityRow({ row }) {
  const fix = fixFor(row);
  const facts = [ORIGINS[row.origin] ?? row.origin, row.version && `Version ${row.version}`, usedBy(row)].filter(Boolean);
  return (
    <li className="eos-cap-row">
      <button type="button" className="eos-cap-row__open" onClick={() => openLocation(buildLocation({ screen: "capability", capabilityId: row.id }))}>
        <span className="eos-cap-row__name">{row.name}</span>
        <span className="eos-cap-row__facts">{facts.join(" · ")}</span>
      </button>
      <CapabilityState row={row} />
      {fix && <FixButton row={row} fix={fix} />}
    </li>
  );
}

// eos:/capabilities: every capability with its state, the one action that fixes
// a bad state, who uses it and its version.
export function CapabilitiesScreen() {
  const { list, listFailed, devRun } = useCapabilities();
  useEffect(() => ensureCapabilitiesLoaded(), []);

  let body;
  if (list === null) body = listFailed ? <LoadFailed what="capabilities" retry={() => void refreshCapabilities()} /> : <Loading />;
  else if (list.length === 0) body = <p className="eos-note">Eos has no capabilities yet.</p>;
  else body = <ul className="eos-card eos-caps" aria-label="Capabilities">{list.map((row) => <CapabilityRow key={row.id} row={row} />)}</ul>;

  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Capabilities" }]} />
      <div className="eos-body">
        {devRun && <DevRunNote />}
        {body}
      </div>
      <SignInSheet />
    </main>
  );
}
