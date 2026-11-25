import { useEffect } from "react";
import { ensureCapabilitiesLoaded, refreshCapabilities, useCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { EmptyState, Section } from "../frame.jsx";
import { numberWord } from "../home/homeWords.js";
import { DevRunNote, FixButton, LoadFailed, Loading, OfflineNote } from "./parts.jsx";
import { SignInSheet } from "./SignInSheet.jsx";
import { fixFor, madeOf, stateLine, stateTone, stateWord, usedBy } from "./words.js";

// One capability: its name, why it is in its state (when that needs saying)
// and what it is made of, then its state and the one action that fixes it.
function CapabilityRow({ row }) {
  const fix = fixFor(row);
  const facts = [...madeOf(row), row.version && `Version ${row.version}`, usedBy(row)].filter(Boolean);
  const tone = stateTone(row);
  const line = stateLine(row);
  return (
    <li className="eos-cap-row">
      <button type="button" className="eos-cap-row__open" onClick={() => openLocation(buildLocation({ screen: "capability", capabilityId: row.id }))}>
        <span className="eos-cap-row__name">{row.name}</span>
        {line && <span className="eos-cap-line">{line}</span>}
        <span className="eos-cap-row__facts">{facts.join(" · ")}</span>
      </button>
      <span className="eos-cap-row__side">
        <span className={tone ? `eos-status eos-status--${tone}` : "eos-status"}>{stateWord(row)}</span>
        {fix && <FixButton row={row} fix={fix} />}
      </span>
    </li>
  );
}

// Those that need a look first (their state in a warning tone), then the
// ready ones, then those turned off or not installed here.
const OFF = new Set(["disabled", "available"]);
const GROUPS = [
  { key: "look", label: "Needs a look", has: (row) => !OFF.has(row.state) && stateTone(row) !== null && stateTone(row) !== "ok" },
  { key: "ready", label: "Ready", has: (row) => !OFF.has(row.state) && (stateTone(row) === null || stateTone(row) === "ok") },
  { key: "off", label: "Turned off", has: (row) => OFF.has(row.state) },
];

const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);

// The lead: how many there are and how many need a look, in words.
export function capabilitiesLead(list) {
  const look = list.filter(GROUPS[0].has).length;
  const all = list.length === 1 ? "One capability" : `${capital(numberWord(list.length))} capabilities`;
  if (look === 0) return `${all}, all of them in order.`;
  if (list.length === 1) return `${all}, and it needs a look.`;
  return `${all}, ${numberWord(look)} of them ${look === 1 ? "needs" : "need"} a look.`;
}

// eos:/capabilities: what Eos and its agents can reach, grouped by what they
// need from the user, each with its state, the one action that fixes a bad
// state, who uses it and its version.
export function CapabilitiesScreen() {
  const { list, listFailed, devRun } = useCapabilities();
  useEffect(() => ensureCapabilitiesLoaded(), []);

  let body;
  if (list === null) body = listFailed ? <LoadFailed what="capabilities" retry={() => void refreshCapabilities()} /> : <Loading />;
  else if (list.length === 0) {
    body = (
      <EmptyState title="Nothing to reach yet">
        Eos has no capabilities yet. When a routine needs a service, a program or a skill, it shows here with what it may do and what it needs from you.
      </EmptyState>
    );
  } else {
    body = (
      <>
        <div>
          <p className="eos-lead">{capabilitiesLead(list)}</p>
          <p className="eos-lead__sub">What Eos and its agents can reach. Open one to see what it may do and who uses it.</p>
        </div>
        {GROUPS.map((g) => {
          const rows = list.filter(g.has);
          if (rows.length === 0) return null;
          return (
            <Section key={g.key} id={`eos-caps-${g.key}`} label={g.label} aside={rows.length}>
              <ul className="eos-caps">{rows.map((row) => <CapabilityRow key={row.id} row={row} />)}</ul>
            </Section>
          );
        })}
      </>
    );
  }

  return (
    <main className={list?.length === 0 ? "eos-screen eos-screen--read" : "eos-screen"}>
      <EosHeader trail={[{ label: "Capabilities" }]} />
      <OfflineNote />
      <div className="eos-body">
        {devRun && <DevRunNote />}
        {body}
      </div>
      <SignInSheet />
    </main>
  );
}
