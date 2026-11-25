import { useEffect } from "react";
import { ensureCapabilitiesLoaded, refreshCapabilities, useCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { ensureInboxLoaded, useInbox } from "../../../state/eos/inboxStore.js";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { EmptyState, FailedLead, Ring, Section } from "../frame.jsx";
import { numberWord } from "../home/homeWords.js";
import { DevRunNote, FixButton, LoadingRows, OfflineNote } from "./parts.jsx";
import { SignInSheet } from "./SignInSheet.jsx";
import { fixFor, formGlyph, madeOf, needsLine, stateLine, stateTone, stateWord, usedByShort } from "./words.js";

// One capability: its form's glyph in a ring lit in its state's tone, its
// name with how it is made, why it is in its state (or what it does), then
// who uses it, its state in words and the one action that fixes it.
function CapabilityRow({ row }) {
  const fix = fixFor(row);
  const tone = stateTone(row);
  const line = stateLine(row);
  const off = row.state === "disabled" || row.state === "available";
  const open = () => openLocation(buildLocation({ screen: "capability", capabilityId: row.id }));
  return (
    <li className={off ? "eos-cap-row eos-cap-row--off" : "eos-cap-row"}>
      <Ring d={formGlyph(row)} tone={tone === "ok" ? null : tone} />
      <button type="button" className="eos-cap-row__open" onClick={open}>
        <span className="eos-cap-row__title">
          <span className="eos-cap-row__name">{row.name}</span>
          <span className="eos-cap-row__facts">{madeOf(row).join(" · ")}</span>
        </span>
        {line ? <span className="eos-cap-line">{line}</span> : row.summary && <span className="eos-cap-row__summary">{row.summary}</span>}
      </button>
      <span className="eos-cap-row__used">{usedByShort(row)}</span>
      <span className={tone ? `eos-cap-row__state eos-cap-row__state--${tone}` : "eos-cap-row__state"}>{stateWord(row)}</span>
      <span className="eos-cap-row__fix">{fix && <FixButton row={row} fix={fix} />}</span>
    </li>
  );
}

// A capability the Forge made and proposes: it waits in Needs you for a yes.
function ProposalRow({ item }) {
  const open = () => openLocation(`eos:/needs/${encodeURIComponent(item.id)}`);
  return (
    <li className="eos-cap-row eos-cap-row--asks">
      <Ring d="M8 3v10M3 8h10" tone="active" />
      <button type="button" className="eos-cap-row__open" onClick={open}>
        <span className="eos-cap-row__title">
          <span className="eos-cap-row__name">{item.title}</span>
          <span className="eos-cap-row__facts">Made by the Forge</span>
        </span>
        {item.summary && <span className="eos-cap-row__summary">{item.summary}</span>}
      </button>
      <span className="eos-cap-row__used" />
      <span className="eos-cap-row__state eos-cap-row__state--active">Waits for your yes</span>
      <span className="eos-cap-row__fix"><button type="button" className="eos-btn" onClick={open}>Look at it</button></span>
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
// state and who uses it; the Forge's proposals first, waiting for a yes.
export function CapabilitiesScreen() {
  const { list, listFailed, devRun } = useCapabilities();
  const inbox = useInbox();
  useEffect(() => {
    ensureCapabilitiesLoaded();
    ensureInboxLoaded();
  }, []);
  const proposals = (inbox.list?.items ?? []).filter((i) => i.kind === "capability_install" && i.state === "open");

  let body;
  if (list === null) body = listFailed ? <FailedLead what="capabilities" retry={() => void refreshCapabilities()} /> : <LoadingRows rows={5} />;
  else if (list.length === 0) {
    body = (
      <EmptyState title="Nothing to reach yet">
        Eos has no capabilities yet. When a routine needs a service, a program or a skill, it shows here with what it may do and what it needs from you.
      </EmptyState>
    );
  } else {
    body = (
      <>
        <header className="eos-rlead eos-caps-lead">
          <p className="eos-label">Capabilities</p>
          <p className="eos-lead">{capabilitiesLead(list)}</p>
          <p className="eos-rlead__now">{needsLine(list)}</p>
        </header>
        {proposals.length > 0 && (
          <Section id="eos-caps-asks" label="Waiting for your yes" aside={proposals.length}>
            <ul className="eos-caps">{proposals.map((item) => <ProposalRow key={item.id} item={item} />)}</ul>
          </Section>
        )}
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
